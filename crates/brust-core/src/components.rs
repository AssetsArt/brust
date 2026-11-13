//! F519 runtime components (plan 2026-11-11, R5): the registry of artifacts a `<Dynamic>` slot
//! renders, the per-render map of one page ([`RenderSlots`]), the sub-render and the chunk route.
//!
//! A page renders once; a slot whose ref the registry does not know is collected and prints nothing.
//! With any collected, the pipeline makes ONE `component` worker call, registers the answers into
//! the page's own map and renders once more, reading only that map (R5.5): an eviction or another
//! request's registration between the passes cannot change the page.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use bytes::Bytes;
use http::{HeaderMap, Response};
use minijinja::Environment;
use minijinja::value::{Value, ValueKind};
use serde::Deserialize;

use crate::body;
use crate::core::Core;
use crate::host::{CallError, Host};
use crate::manifest::Manifest;
use crate::protocol::{ComponentRequest, ComponentResponse, RenderItem};

/// R2: the biggest `jinja` and `client` an artifact may carry.
pub const MAX_JINJA_BYTES: usize = 256 * 1024;
pub const MAX_CLIENT_BYTES: usize = 256 * 1024;
/// R5.4: warm artifacts kept (`[components] cache_entries`).
pub const DEFAULT_CACHE_ENTRIES: usize = 2048;
/// R5.4 (amended): the negative memory (missing / refused refs) is itself bounded.
pub const NEGATIVE_ENTRIES: usize = 4096;
/// R5.4 / R5.7 (a): how long a `missing` or refused answer is remembered, and the longest a page
/// with a missing slot is cached.
pub const NEGATIVE_TTL_SECS: u64 = 10;
const NEGATIVE_TTL_NS: u64 = NEGATIVE_TTL_SECS * 1_000_000_000;
/// R5.6 (amended): the fuel an artifact's sub-render may burn (the app's environment has none).
pub const ARTIFACT_FUEL: u64 = 2_000_000;
/// The most one slot may print: fuel bounds the instructions, not what each one writes, so the output is capped too;
/// past it the sub-render fails (R5.7 d).
pub const MAX_SLOT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// F546 (R5): the island HTML cache's total bytes. Entries are also bounded by `[components] cache_entries` and each by
/// [`MAX_SLOT_OUTPUT_BYTES`]; without a byte cap 2048 entries of 4 MiB could pin 8 GiB. 64 MiB keeps thousands of typical
/// (KB-sized) slot outputs warm at a bounded cost per server process, next to the L1 page cache.
pub const HTML_CACHE_BYTES: usize = 64 * 1024 * 1024;
/// R5.9 (amended): cold resolves through the chunk path in flight at once.
pub const MAX_COLD_ASSET_RESOLVES: usize = 4;
/// The one template in an artifact's own environment.
const TEMPLATE: &str = "rc";

/// R5.3: a ref is 1-128 of `[A-Za-z0-9_-]`.
pub fn valid_ref(r: &str) -> bool {
    (1..=128).contains(&r.len())
        && r.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// R3.3 (amended): an artifact id is 1-128 of `[A-Za-z0-9_]`.
fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The R2 artifact as the resolver returned it.
#[derive(Debug, Deserialize)]
struct ArtifactWire {
    v: u32,
    build: String,
    id: String,
    tier: String,
    /// Absent for an island artifact (F546 R1): its HTML comes from `components.render`.
    #[serde(default)]
    jinja: Option<String>,
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    features: Vec<String>,
    #[serde(default)]
    stores: Vec<String>,
}

/// One registered artifact: parsed once (R5.4), in its own environment (R5.6).
pub struct Artifact {
    pub reference: String,
    pub id: String,
    pub native: bool,
    /// F546 (R1): `tier: "island"` — the slot prints a `<brust-island>` host around the app's own HTML, and `client`
    /// registers the hydrate function.
    pub island: bool,
    pub features: Vec<String>,
    client: Option<Bytes>,
    gzip: OnceLock<Option<Bytes>>,
    digest: blake3::Hash,
    env: Environment<'static>,
}

impl std::fmt::Debug for Artifact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Artifact")
            .field("reference", &self.reference)
            .field("id", &self.id)
            .field("native", &self.native)
            .field("island", &self.island)
            .finish_non_exhaustive()
    }
}

impl Artifact {
    /// R5.6: the template with `props` keys at top level, `_props` = the props map, `__store` =
    /// the page's snapshot. Nothing else of the page context.
    fn render(&self, props: &Value, store: &Value) -> Result<String, minijinja::Error> {
        let mut ctx: BTreeMap<String, Value> = BTreeMap::new();
        let props = if props.kind() == ValueKind::Map {
            for k in props.try_iter()? {
                if let Some(name) = k.as_str() {
                    ctx.insert(name.to_string(), props.get_item(&k)?);
                }
            }
            props.clone()
        } else {
            Value::from(BTreeMap::<String, Value>::new())
        };
        ctx.insert("_props".into(), props);
        if !store.is_undefined() && !store.is_none() {
            ctx.insert("__store".into(), store.clone());
        } else {
            ctx.remove("__store");
        }
        let mut buf = Vec::new();
        self.env.get_template(TEMPLATE)?.render_captured_to(
            Value::from(ctx),
            Capped {
                out: &mut buf,
                cap: MAX_SLOT_OUTPUT_BYTES,
            },
        )?;
        // minijinja writes whole `&str`s, so the bytes are UTF-8.
        String::from_utf8(buf).map_err(|_| {
            minijinja::Error::new(
                minijinja::ErrorKind::InvalidOperation,
                "the slot's output is not UTF-8",
            )
        })
    }
}

/// A writer that refuses past `cap` bytes ([`MAX_SLOT_OUTPUT_BYTES`]).
struct Capped<'a> {
    out: &'a mut Vec<u8>,
    cap: usize,
}

impl std::io::Write for Capped<'_> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if self.out.len() + b.len() > self.cap {
            return Err(std::io::Error::other(format!(
                "the slot printed more than {} bytes",
                self.cap
            )));
        }
        self.out.extend_from_slice(b);
        Ok(b.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A bounded map, least recently used out first.
struct Lru<V> {
    cap: usize,
    tick: u64,
    map: HashMap<String, (V, u64)>,
    order: BTreeMap<u64, String>,
}

impl<V: Clone> Lru<V> {
    fn new(cap: usize) -> Self {
        Lru {
            cap: cap.max(1),
            tick: 0,
            map: HashMap::new(),
            order: BTreeMap::new(),
        }
    }

    fn get(&mut self, k: &str) -> Option<V> {
        self.tick += 1;
        let tick = self.tick;
        let (v, t) = self.map.get_mut(k)?;
        self.order.remove(t);
        *t = tick;
        self.order.insert(tick, k.to_string());
        Some(v.clone())
    }

    fn insert(&mut self, k: String, v: V) {
        self.remove(&k);
        while self.map.len() >= self.cap {
            let Some((_, old)) = self.order.pop_first() else {
                break;
            };
            self.map.remove(&old);
        }
        self.tick += 1;
        self.order.insert(self.tick, k.clone());
        self.map.insert(k, (v, self.tick));
    }

    fn remove(&mut self, k: &str) -> Option<V> {
        let (v, t) = self.map.remove(k)?;
        self.order.remove(&t);
        Some(v)
    }

    fn len(&self) -> usize {
        self.map.len()
    }

    /// Drop the least recently used entry.
    fn pop_oldest(&mut self) -> Option<V> {
        let (_, k) = self.order.pop_first()?;
        self.map.remove(&k).map(|(v, _)| v)
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.map.values().map(|(v, _)| v)
    }
}

/// F546 (R5): island HTML by (ref, artifact digest, canonical props), bounded in entries and in bytes. `None` = the
/// app's `render` answered null (cached too: it is the app's answer for those props).
struct HtmlCache {
    lru: Lru<Option<Arc<str>>>,
    bytes: usize,
    cap_bytes: usize,
}

impl HtmlCache {
    fn size(v: &Option<Arc<str>>) -> usize {
        v.as_ref().map_or(0, |h| h.len())
    }

    fn get(&mut self, k: &str) -> Option<Option<Arc<str>>> {
        self.lru.get(k)
    }

    fn insert(&mut self, k: String, v: Option<Arc<str>>) {
        let n = Self::size(&v);
        if n > self.cap_bytes {
            return;
        }
        if let Some(old) = self.lru.remove(&k) {
            self.bytes -= Self::size(&old);
        }
        while self.lru.len() >= self.lru.cap || self.bytes + n > self.cap_bytes {
            let Some(old) = self.lru.pop_oldest() else {
                break;
            };
            self.bytes -= Self::size(&old);
        }
        self.lru.insert(k, v);
        self.bytes += n;
    }
}

/// The registry's cache key of one island output: a new artifact digest for the ref makes the old entries unreachable.
fn html_key(reference: &str, digest: &blake3::Hash, canon: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&(reference.len() as u64).to_le_bytes());
    h.update(reference.as_bytes());
    h.update(digest.as_bytes());
    h.update(canon.as_bytes());
    h.finalize().to_hex().to_string()
}

/// The page-local name of one (ref, props) pair: the `key` of a [`RenderItem`].
fn pair_key(reference: &str, canon: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&(reference.len() as u64).to_le_bytes());
    h.update(reference.as_bytes());
    h.update(canon.as_bytes());
    h.finalize().to_hex()[..32].to_string()
}

/// A JSON value with every object's keys sorted, whatever map type serde_json was built with.
fn sorted(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let mut entries: Vec<(String, serde_json::Value)> = m.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            serde_json::Value::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.into_iter().map(sorted).collect())
        }
        other => other,
    }
}

/// The props a slot passes as canonical JSON (a non-map is `{}`, like a static artifact's `_props`): the value sent to
/// `render` and its text, the cache key's input.
fn canonical_props(props: &Value) -> Result<(serde_json::Value, String), String> {
    let v = if props.kind() == ValueKind::Map {
        serde_json::to_value(props).map_err(|e| format!("props are not JSON: {e}"))?
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    };
    let v = sorted(v);
    let text = v.to_string();
    Ok((v, text))
}

/// A unique id per page render (A3 `page.id`).
fn next_page_id(now_ns: u64) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("{now_ns:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// A remembered negative answer (R5.4, R5.7 a/b).
#[derive(Clone, Debug)]
enum Negative {
    Missing { until_ns: u64 },
    Refused { until_ns: u64, why: Arc<str> },
}

/// What a ref is for one page (R5.5 amended).
#[derive(Clone, Debug)]
enum Slot {
    Ready(Arc<Artifact>),
    /// (a) the resolver answered null.
    Missing,
    /// (b) a registration check failed.
    Refused,
    /// (c) the resolver threw or the call failed.
    Failed,
}

/// The registry of one server (one per `Core`, present only when the manifest has a slot).
pub struct Registry {
    build: String,
    base: String,
    features: BTreeSet<String>,
    stores: BTreeSet<String>,
    components: BTreeSet<String>,
    warm: Mutex<Lru<Arc<Artifact>>>,
    /// F546 (R5): island HTML per (ref, digest, props).
    html: Mutex<HtmlCache>,
    negative: Mutex<Lru<Negative>>,
    /// Refs already logged as invalid (R5.3: once per ref), bounded.
    logged: Mutex<Lru<()>>,
    cold_assets: AtomicUsize,
    /// `brust_jinja::register` + the `safe` override + the fuel cap, cloned per artifact.
    base_env: Environment<'static>,
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry")
            .field("build", &self.build)
            .finish_non_exhaustive()
    }
}

impl Registry {
    /// `None` when no component of `m` holds a slot (the feature is off).
    pub fn for_manifest(m: &Manifest, cache_entries: Option<usize>) -> Option<Registry> {
        if !m.components.values().any(|c| c.dynamic) {
            return None;
        }
        let mut base_env = Environment::new();
        base_env.set_auto_reload(false);
        brust_jinja::register(&mut base_env);
        base_env.add_filter("safe", crate::render::safe_filter);
        base_env.set_fuel(Some(ARTIFACT_FUEL));
        Some(Registry {
            build: m.assets.build.clone().unwrap_or_default(),
            base: m.base_path.clone(),
            features: m.assets.features.keys().cloned().collect(),
            stores: m
                .runtime
                .as_ref()
                .map(|r| r.stores.keys().cloned().collect())
                .unwrap_or_default(),
            components: m.components.keys().cloned().collect(),
            warm: Mutex::new(Lru::new(cache_entries.unwrap_or(DEFAULT_CACHE_ENTRIES))),
            html: Mutex::new(HtmlCache {
                lru: Lru::new(cache_entries.unwrap_or(DEFAULT_CACHE_ENTRIES)),
                bytes: 0,
                cap_bytes: HTML_CACHE_BYTES,
            }),
            negative: Mutex::new(Lru::new(NEGATIVE_ENTRIES)),
            logged: Mutex::new(Lru::new(NEGATIVE_ENTRIES)),
            cold_assets: AtomicUsize::new(0),
            base_env,
        })
    }

    fn warm(&self, r: &str) -> Option<Arc<Artifact>> {
        self.warm.lock().ok()?.get(r)
    }

    /// The live negative answer for `r`, dropping an expired one.
    fn negative(&self, r: &str, now_ns: u64) -> Option<Negative> {
        let mut n = self.negative.lock().ok()?;
        let hit = n.get(r)?;
        let until = match &hit {
            Negative::Missing { until_ns } | Negative::Refused { until_ns, .. } => *until_ns,
        };
        if now_ns >= until {
            n.remove(r);
            return None;
        }
        Some(hit)
    }

    fn remember(&self, r: &str, neg: Negative) {
        if let Ok(mut n) = self.negative.lock() {
            n.insert(r.to_string(), neg);
        }
    }

    /// Whether `r` was not logged as invalid before (and marks it).
    fn first_log(&self, r: &str) -> bool {
        let Ok(mut l) = self.logged.lock() else {
            return false;
        };
        if l.get(r).is_some() {
            return false;
        }
        l.insert(r.to_string(), ());
        true
    }

    /// Warm entries (tests, stats).
    pub fn warm_len(&self) -> usize {
        self.warm.lock().map_or(0, |w| w.len())
    }

    /// Island HTML entries and their bytes (tests, stats).
    pub fn html_stats(&self) -> (usize, usize) {
        self.html.lock().map_or((0, 0), |h| (h.lru.len(), h.bytes))
    }

    /// Set the island HTML cache's byte cap (tests).
    #[doc(hidden)]
    pub fn set_html_cap_bytes(&self, cap: usize) {
        if let Ok(mut h) = self.html.lock() {
            h.cap_bytes = cap;
        }
    }

    fn cached_html(&self, k: &str) -> Option<Option<Arc<str>>> {
        self.html.lock().ok()?.get(k)
    }

    fn cache_html(&self, k: String, v: Option<Arc<str>>) {
        if let Ok(mut h) = self.html.lock() {
            h.insert(k, v);
        }
    }

    /// Drop a warm entry (tests: an eviction between the passes).
    #[doc(hidden)]
    pub fn evict(&self, r: &str) {
        if let Ok(mut w) = self.warm.lock() {
            w.remove(r);
        }
    }

    /// R5.4: check `raw` and register it under `r`. `Err` = refused, with the reason.
    pub fn register(&self, r: &str, raw: serde_json::Value) -> Result<Arc<Artifact>, String> {
        let a: ArtifactWire =
            serde_json::from_value(raw).map_err(|e| format!("not an artifact: {e}"))?;
        if a.v != 1 {
            return Err(format!("artifact version {} (want 1)", a.v));
        }
        if a.build != self.build {
            return Err(format!(
                "compiled for build {:?}, this server runs {:?}: recompile it",
                a.build, self.build
            ));
        }
        let (native, island) = match (a.tier.as_str(), &a.client, &a.jinja) {
            ("static", None, Some(_)) => (false, false),
            ("native", Some(_), Some(_)) => (true, false),
            ("island", Some(_), None) => (false, true),
            ("static", Some(_), _) => return Err("a static artifact has no client".into()),
            ("native", None, _) => return Err("a native artifact needs its client".into()),
            ("island", None, _) => return Err("an island artifact needs its client".into()),
            ("island", Some(_), Some(_)) => {
                return Err(
                    "an island artifact has no jinja: its HTML comes from components.render".into(),
                );
            }
            ("static" | "native", _, None) => {
                return Err(format!("a {} artifact needs its jinja", a.tier));
            }
            (t, _, _) => return Err(format!("tier {t:?} (want static, native or island)")),
        };
        if !valid_id(&a.id) {
            return Err(format!("id {:?} is not [A-Za-z0-9_]{{1,128}}", a.id));
        }
        if self.components.contains(&a.id) {
            return Err(format!("id {:?} is a component of the build", a.id));
        }
        let jinja = a.jinja.unwrap_or_default();
        if jinja.len() > MAX_JINJA_BYTES {
            return Err(format!(
                "jinja is {} bytes (max {MAX_JINJA_BYTES})",
                jinja.len()
            ));
        }
        if let Some(c) = &a.client
            && c.len() > MAX_CLIENT_BYTES
        {
            return Err(format!(
                "client is {} bytes (max {MAX_CLIENT_BYTES})",
                c.len()
            ));
        }
        if let Some(f) = a.features.iter().find(|f| !self.features.contains(*f)) {
            return Err(format!("runtime feature {f:?} is not in this build"));
        }
        if let Some(s) = a.stores.iter().find(|s| !self.stores.contains(*s)) {
            return Err(format!("store {s:?} is not exposed by this build"));
        }
        let mut features = a.features;
        // F546 (R1): the host hydrates through the island runtime feature.
        if island && !features.iter().any(|f| f == "island") {
            if !self.features.contains("island") {
                return Err("runtime feature \"island\" is not in this build".into());
            }
            features.push("island".into());
        }
        let digest = {
            let mut h = blake3::Hasher::new();
            h.update(&(jinja.len() as u64).to_le_bytes());
            h.update(jinja.as_bytes());
            h.update(a.client.as_deref().unwrap_or_default().as_bytes());
            h.finalize()
        };
        let mut env = self.base_env.clone();
        if !island {
            env.add_template_owned(TEMPLATE, jinja)
                .map_err(|e| format!("template: {e:#}"))?;
        }
        let art = Arc::new(Artifact {
            reference: r.to_string(),
            id: a.id,
            native,
            island,
            features,
            client: a.client.map(Bytes::from),
            gzip: OnceLock::new(),
            digest,
            env,
        });
        let Ok(mut warm) = self.warm.lock() else {
            return Err("registry lock poisoned".into());
        };
        // Two different behaviors under one id would meet in the browser's `defineBehavior` table.
        if warm
            .values()
            .any(|o| o.id == art.id && o.reference != r && o.digest != art.digest)
        {
            return Err(format!(
                "id {:?} is already used by another ref with different code",
                art.id
            ));
        }
        // F546 A2: the chunk URL `/_brust/rc/<build>/<ref>/<id>.js` is cached for good; new code under the same ref
        // and id would be served stale by every cache that kept the old one. A new client needs a new id.
        if let Some(old) = warm.get(r)
            && old.client.is_some()
            && old.id == art.id
            && old.digest != art.digest
        {
            return Err(format!(
                "ref {r:?} is already registered with id {:?} and different code: change the id when the code changes",
                art.id
            ));
        }
        warm.insert(r.to_string(), Arc::clone(&art));
        drop(warm);
        if let Ok(mut n) = self.negative.lock() {
            n.remove(r);
        }
        Ok(art)
    }

    /// The chunk URL of `a` (R5.9 amended).
    fn chunk_url(&self, a: &Artifact) -> String {
        format!(
            "{}/_brust/rc/{}/{}/{}.js",
            self.base, self.build, a.reference, a.id
        )
    }
}

/// The ref a slot names: a string, or an integer printed as JS would.
fn ref_of(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if v.kind() == ValueKind::Number && v.is_integer() {
        return Some(v.to_string());
    }
    None
}

/// The page assets the rendered artifacts need (R5.9).
#[derive(Debug, Default)]
pub struct SlotAssets {
    /// Runtime feature names (keys of `assets.features`).
    pub features: BTreeSet<String>,
    /// Chunk URLs, base path included, in first-render order.
    pub chunks: Vec<String>,
    /// A native or island artifact rendered: the page needs the runtime.
    pub native: bool,
}

/// F546: what one island pair prints for this page.
#[derive(Clone, Debug)]
enum Html {
    /// The app's HTML (`None`: `render` answered null).
    Ready(Option<Arc<str>>),
    /// `render` threw, its output was over the cap, or no answer came: an empty host, the page is not stored.
    Failed,
}

#[derive(Debug, Default)]
struct SlotState {
    pass2: bool,
    map: HashMap<String, Slot>,
    cold: Vec<String>,
    /// F546 (R4): the (ref, props) pairs pass 1 needs HTML for — every cold ref's slot and every warm island slot
    /// whose HTML is not cached — once per pair key.
    renders: Vec<RenderItem>,
    /// F546: the page's island HTML by pair key (R5.5: pass 2 reads only this).
    html: HashMap<String, Html>,
    rendered: Vec<Arc<Artifact>>,
    /// (a) seen in this pass.
    missing: bool,
    /// (b), (c) or a pass-2 bug seen in this pass.
    failed: bool,
    /// One line per failed slot of this pass, logged by [`RenderSlots::finish`].
    notes: Vec<(String, String)>,
}

/// One page's view of the registry (R5.5 amended): the context object `brust_dynamic` calls.
#[derive(Debug)]
pub struct RenderSlots {
    reg: Arc<Registry>,
    now_ns: u64,
    store: Value,
    state: Mutex<SlotState>,
}

impl RenderSlots {
    pub fn new(reg: Arc<Registry>, now_ns: u64, store: Value) -> Self {
        RenderSlots {
            reg,
            now_ns,
            store,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The refs pass 1 could not place (empty after pass 2).
    pub fn cold(&self) -> Vec<String> {
        let s = self.state();
        if s.pass2 { Vec::new() } else { s.cold.clone() }
    }

    /// F546 (R4): the island renders pass 1 needs (empty after pass 2).
    pub fn renders(&self) -> Vec<RenderItem> {
        let s = self.state();
        if s.pass2 {
            Vec::new()
        } else {
            s.renders.clone()
        }
    }

    /// F546 A3: this page render's id, the `page.id` every `render` call of the page sees.
    pub fn page_id(&self) -> String {
        next_page_id(self.now_ns)
    }

    /// Fold the `component` call's outcome into the page's map, register what came back, and
    /// switch to pass 2. Every collected ref gets an entry, and every asked render whose ref is an island
    /// artifact gets its HTML (F546).
    pub fn resolved(
        &self,
        refs: &[String],
        renders: &[RenderItem],
        r: Result<ComponentResponse, CallError>,
    ) {
        let mut html_answers = Vec::new();
        let r = r.map(|mut resp| {
            html_answers = std::mem::take(&mut resp.html);
            resp
        });
        let call_failed = r
            .as_ref()
            .err()
            .map(|e| format!("component call failed: {e}"));
        let mut out: HashMap<String, (Slot, Option<String>)> = HashMap::new();
        match r {
            Ok(resp) => {
                for res in resp.results {
                    if !refs.contains(&res.reference) || out.contains_key(&res.reference) {
                        continue;
                    }
                    let entry = if let Some(raw) = res.artifact {
                        match self.reg.register(&res.reference, raw) {
                            Ok(a) => (Slot::Ready(a), None),
                            Err(why) => {
                                self.reg.remember(
                                    &res.reference,
                                    Negative::Refused {
                                        until_ns: self.now_ns + NEGATIVE_TTL_NS,
                                        why: Arc::from(why.as_str()),
                                    },
                                );
                                (Slot::Refused, Some(format!("refused: {why}")))
                            }
                        }
                    } else if let Some(e) = res.error {
                        (Slot::Failed, Some(format!("resolver threw: {e}")))
                    } else {
                        // `missing: true`, or a result naming neither: nothing to render.
                        self.reg.remember(
                            &res.reference,
                            Negative::Missing {
                                until_ns: self.now_ns + NEGATIVE_TTL_NS,
                            },
                        );
                        (Slot::Missing, None)
                    };
                    out.insert(res.reference, entry);
                }
            }
            Err(e) => {
                let why = format!("component call failed: {e}");
                for r in refs {
                    out.insert(r.clone(), (Slot::Failed, Some(why.clone())));
                }
            }
        }
        let mut s = self.state();
        for r in refs {
            let (slot, why) = out
                .remove(r)
                .unwrap_or_else(|| (Slot::Failed, Some("the resolver gave no answer".into())));
            if let Some(why) = why {
                // Pass 2 logs the slot itself; keep the reason for it.
                s.notes.push((r.clone(), why));
            }
            s.map.insert(r.clone(), slot);
        }
        // F546: the HTML of each asked pair whose ref is (now) an island artifact in the page's map.
        // A key answered twice is a worker bug: taken as no answer.
        let mut answers: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        let mut twice = BTreeSet::new();
        for h in html_answers {
            if answers.insert(h.key.clone(), (h.html, h.error)).is_some() {
                twice.insert(h.key);
            }
        }
        for k in twice {
            answers.remove(&k);
        }
        for item in renders {
            let Some(Slot::Ready(a)) = s.map.get(&item.reference).cloned() else {
                continue;
            };
            if !a.island {
                continue;
            }
            let out = match (&call_failed, answers.remove(&item.key)) {
                (Some(why), _) => {
                    s.notes.push((item.reference.clone(), why.clone()));
                    Html::Failed
                }
                (None, Some((_, Some(e)))) => {
                    s.notes
                        .push((item.reference.clone(), format!("render threw: {e}")));
                    Html::Failed
                }
                (None, Some((Some(h), None))) if h.len() > MAX_SLOT_OUTPUT_BYTES => {
                    s.notes.push((
                        item.reference.clone(),
                        format!(
                            "render returned {} bytes (max {MAX_SLOT_OUTPUT_BYTES})",
                            h.len()
                        ),
                    ));
                    Html::Failed
                }
                (None, Some((h, None))) => {
                    let h: Option<Arc<str>> = h.map(Arc::from);
                    let canon = item.props.to_string();
                    self.reg
                        .cache_html(html_key(&a.reference, &a.digest, &canon), h.clone());
                    Html::Ready(h)
                }
                (None, None) => {
                    s.notes.push((
                        item.reference.clone(),
                        "the worker gave no HTML for an island slot".into(),
                    ));
                    Html::Failed
                }
            };
            s.html.insert(item.key.clone(), out);
        }
        // Pass 1's notes stay (a refusal it read from the negative memory); `finish` dedups the rest.
        s.pass2 = true;
        s.cold.clear();
        s.renders.clear();
        s.rendered.clear();
        s.missing = false;
        s.failed = false;
    }

    /// After the final pass: log one line per failed slot.
    pub fn finish(&self) {
        let notes = std::mem::take(&mut self.state().notes);
        let mut seen = BTreeSet::new();
        for (r, why) in notes {
            if seen.insert((r.clone(), why.clone())) {
                tracing::warn!("[brust] runtime component {r}: {why}");
            }
        }
    }

    /// (a): a slot rendered nothing because its ref is missing — the page may be cached for
    /// [`NEGATIVE_TTL_SECS`] at most.
    pub fn saw_missing(&self) -> bool {
        self.state().missing
    }

    /// (b)/(c): the page must not be stored.
    pub fn saw_failure(&self) -> bool {
        self.state().failed
    }

    /// The assets of the artifacts that rendered in the final pass.
    pub fn assets(&self) -> SlotAssets {
        let s = self.state();
        let mut out = SlotAssets::default();
        for a in &s.rendered {
            out.features.extend(a.features.iter().cloned());
            if a.native || a.island {
                out.native = true;
                out.chunks.push(self.reg.chunk_url(a));
            }
        }
        out
    }

    fn slot(&self, r: &str) -> Option<Slot> {
        let mut s = self.state();
        if let Some(slot) = s.map.get(r) {
            return Some(slot.clone());
        }
        if s.pass2 {
            s.failed = true;
            s.notes.push((
                r.to_string(),
                "not in the page's map in the second pass (a bug)".into(),
            ));
            return None;
        }
        let slot = if let Some(a) = self.reg.warm(r) {
            Slot::Ready(a)
        } else {
            match self.reg.negative(r, self.now_ns) {
                Some(Negative::Missing { .. }) => Slot::Missing,
                Some(Negative::Refused { why, .. }) => {
                    s.notes.push((r.to_string(), format!("refused: {why}")));
                    Slot::Refused
                }
                None => {
                    if !s.cold.iter().any(|c| c == r) {
                        s.cold.push(r.to_string());
                    }
                    return None;
                }
            }
        };
        s.map.insert(r.to_string(), slot.clone());
        Some(slot)
    }
}

impl brust_jinja::slot::SlotRender for RenderSlots {
    fn render_slot(&self, reference: &Value, props: &Value) -> String {
        let Some(r) = ref_of(reference).filter(|r| valid_ref(r)) else {
            let shown = reference.to_string();
            if self.reg.first_log(&shown) {
                tracing::warn!(
                    "[brust] runtime component {shown:?}: not a ref ([A-Za-z0-9_-]{{1,128}}); the slot prints nothing"
                );
            }
            return String::new();
        };
        let a = match self.slot(&r) {
            Some(Slot::Ready(a)) => a,
            Some(Slot::Missing) => {
                self.state().missing = true;
                return String::new();
            }
            Some(Slot::Refused | Slot::Failed) => {
                self.state().failed = true;
                return String::new();
            }
            None => {
                // A cold ref (pass 1): it may come back as an island artifact, so its HTML is asked in the same call.
                let mut s = self.state();
                if !s.pass2
                    && let Ok((v, text)) = canonical_props(props)
                {
                    let key = pair_key(&r, &text);
                    if !s.renders.iter().any(|i| i.key == key) {
                        s.renders.push(RenderItem {
                            reference: r.clone(),
                            key,
                            props: v,
                        });
                    }
                }
                return String::new();
            }
        };
        if a.island {
            return self.island_slot(&r, &a, props);
        }
        match a.render(props, &self.store) {
            Ok(html) => {
                let mut s = self.state();
                if !s.rendered.iter().any(|x| x.reference == a.reference) {
                    s.rendered.push(Arc::clone(&a));
                }
                html
            }
            Err(e) => {
                // (d): deterministic for this artifact and these props; the page is stored.
                self.state()
                    .notes
                    .push((r, format!("render failed: {e:#}")));
                String::new()
            }
        }
    }
}

impl RenderSlots {
    /// F546 (R2): `<brust-island … data-id x-props>` around the app's HTML for these props — from the page's map, else
    /// (pass 1) the registry's HTML cache, else the pair is asked in the `component` call and the slot waits for pass 2.
    fn island_slot(&self, r: &str, a: &Arc<Artifact>, props: &Value) -> String {
        let props = if props.kind() == ValueKind::Map {
            props.clone()
        } else {
            Value::from(BTreeMap::<String, Value>::new())
        };
        let fail = |s: &mut SlotState, why: String| {
            s.failed = true;
            s.notes.push((r.to_string(), why));
        };
        let (v, text) = match canonical_props(&props) {
            Ok(c) => c,
            Err(e) => {
                fail(&mut self.state(), e);
                return String::new();
            }
        };
        let attr = match brust_jinja::to_json_attr(props) {
            Ok(x) => x,
            Err(e) => {
                fail(&mut self.state(), format!("props: {e:#}"));
                return String::new();
            }
        };
        let key = pair_key(r, &text);
        let mut s = self.state();
        let html = match s.html.get(&key).cloned() {
            Some(h) => h,
            None if s.pass2 => {
                fail(
                    &mut s,
                    "island HTML not in the page's map in the second pass (a bug)".into(),
                );
                Html::Failed
            }
            None => match self.reg.cached_html(&html_key(r, &a.digest, &text)) {
                Some(h) => {
                    s.html.insert(key, Html::Ready(h.clone()));
                    Html::Ready(h)
                }
                None => {
                    if !s.renders.iter().any(|i| i.key == key) {
                        s.renders.push(RenderItem {
                            reference: r.to_string(),
                            key,
                            props: v,
                        });
                    }
                    // Pass 2 prints it; this pass is thrown away.
                    return String::new();
                }
            },
        };
        let inner = match html {
            Html::Ready(h) => h,
            Html::Failed => {
                s.failed = true;
                None
            }
        };
        if !s.rendered.iter().any(|x| x.reference == a.reference) {
            s.rendered.push(Arc::clone(a));
        }
        let inner = inner.as_deref().unwrap_or_default();
        let mut out = String::with_capacity(inner.len() + attr.len() + a.id.len() + 96);
        out.push_str("<brust-island style=\"display:contents\" data-id=\"");
        out.push_str(&a.id);
        out.push_str("\" x-props='");
        out.push_str(&attr);
        out.push_str("'>");
        out.push_str(inner);
        out.push_str("</brust-island>");
        out
    }
}

/// The warm artifact `r` when it carries `id` and a client (the chunk route's check).
fn chunk_of(reg: &Registry, r: &str, id: &str) -> Option<Arc<Artifact>> {
    reg.warm(r).filter(|a| a.id == id && a.client.is_some())
}

fn not_found() -> Response<Bytes> {
    let mut resp = body::error_404();
    resp.headers_mut().insert(
        http::header::CACHE_CONTROL,
        http::HeaderValue::from_static("no-store"),
    );
    resp
}

/// Releases a cold-resolve permit on drop.
struct Permit<'a>(&'a AtomicUsize);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// R5.9 (amended): `/_brust/rc/<build>/<ref>/<id>.js` (`rest` = what follows `/_brust/rc/`).
pub(crate) async fn chunk<H: Host>(
    s: &Core<H>,
    reg: &Arc<Registry>,
    rest: &str,
    headers: &HeaderMap,
) -> Response<Bytes> {
    let mut parts = rest.split('/');
    let (Some(build), Some(r), Some(file), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return not_found();
    };
    let Some(id) = file.strip_suffix(".js") else {
        return not_found();
    };
    if build != reg.build || !valid_ref(r) || !valid_id(id) {
        return not_found();
    }
    let art = match reg.warm(r) {
        Some(a) => (a.id == id && a.client.is_some()).then_some(a),
        None => {
            if reg.negative(r, s.host.now_ns()).is_some() {
                return not_found();
            }
            if reg.cold_assets.fetch_add(1, Ordering::AcqRel) >= MAX_COLD_ASSET_RESOLVES {
                reg.cold_assets.fetch_sub(1, Ordering::AcqRel);
                return not_found();
            }
            let _permit = Permit(&reg.cold_assets);
            let refs = vec![r.to_string()];
            let resp = s.host.component(&ComponentRequest::refs(&refs)).await;
            let slots = RenderSlots::new(Arc::clone(reg), s.host.now_ns(), Value::UNDEFINED);
            slots.resolved(&refs, &[], resp);
            slots.finish();
            chunk_of(reg, r, id)
        }
    };
    let Some(a) = art else {
        return not_found();
    };
    let Some(js) = a.client.clone() else {
        return not_found();
    };
    let mut h = HeaderMap::new();
    h.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/javascript; charset=utf-8"),
    );
    h.insert(
        http::header::CACHE_CONTROL,
        http::HeaderValue::from_static(crate::static_rules::IMMUTABLE),
    );
    h.insert(
        http::header::X_CONTENT_TYPE_OPTIONS,
        http::HeaderValue::from_static("nosniff"),
    );
    let accept = headers
        .get(http::header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok());
    let gz = if crate::compress::accepts_gzip(accept) && js.len() >= 1024 {
        a.gzip
            .get_or_init(|| crate::compress::gzip(&js, 6).map(Bytes::from))
            .clone()
    } else {
        None
    };
    let bytes = match gz {
        Some(g) => {
            h.insert(
                http::header::CONTENT_ENCODING,
                http::HeaderValue::from_static("gzip"),
            );
            h.insert(
                http::header::VARY,
                http::HeaderValue::from_static("Accept-Encoding"),
            );
            g
        }
        None => js,
    };
    body::resp_with(200, h, bytes)
}
