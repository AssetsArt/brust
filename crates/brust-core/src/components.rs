//! F519 runtime components (plan 2026-11-11, R5): the registry of artifacts a `<Dynamic>` slot
//! renders, the per-render map of one page ([`RenderSlots`]), the sub-render and the chunk route.
//!
//! A page renders once; a slot whose ref the registry does not know is collected and prints nothing.
//! With any collected, the pipeline makes ONE `component` worker call, registers the answers into
//! the page's own map and renders once more, reading only that map (R5.5): an eviction or another
//! request's registration between the passes cannot change the page.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
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
use crate::protocol::{ComponentRequest, ComponentResponse};

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
    jinja: String,
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
        self.env.get_template(TEMPLATE)?.render(Value::from(ctx))
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

    fn values(&self) -> impl Iterator<Item = &V> {
        self.map.values().map(|(v, _)| v)
    }
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
        let native = match (a.tier.as_str(), &a.client) {
            ("static", None) => false,
            ("native", Some(_)) => true,
            ("static", Some(_)) => return Err("a static artifact has no client".into()),
            ("native", None) => return Err("a native artifact needs its client".into()),
            (t, _) => return Err(format!("tier {t:?} (want static or native)")),
        };
        if !valid_id(&a.id) {
            return Err(format!("id {:?} is not [A-Za-z0-9_]{{1,128}}", a.id));
        }
        if self.components.contains(&a.id) {
            return Err(format!("id {:?} is a component of the build", a.id));
        }
        if a.jinja.len() > MAX_JINJA_BYTES {
            return Err(format!(
                "jinja is {} bytes (max {MAX_JINJA_BYTES})",
                a.jinja.len()
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
        let digest = {
            let mut h = blake3::Hasher::new();
            h.update(&(a.jinja.len() as u64).to_le_bytes());
            h.update(a.jinja.as_bytes());
            h.update(a.client.as_deref().unwrap_or_default().as_bytes());
            h.finalize()
        };
        let mut env = self.base_env.clone();
        env.add_template_owned(TEMPLATE, a.jinja)
            .map_err(|e| format!("template: {e:#}"))?;
        let art = Arc::new(Artifact {
            reference: r.to_string(),
            id: a.id,
            native,
            features: a.features,
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
    /// A native artifact rendered: the page needs the runtime.
    pub native: bool,
}

#[derive(Debug, Default)]
struct SlotState {
    pass2: bool,
    map: HashMap<String, Slot>,
    cold: Vec<String>,
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

    /// Fold the `component` call's outcome into the page's map, register what came back, and
    /// switch to pass 2. Every collected ref gets an entry.
    pub fn resolved(&self, refs: &[String], r: Result<ComponentResponse, CallError>) {
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
        // Pass 1's notes stay (a refusal it read from the negative memory); `finish` dedups the rest.
        s.pass2 = true;
        s.cold.clear();
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
            if a.native {
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
            None => return String::new(),
        };
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
            let resp = s.host.component(&ComponentRequest { refs: &refs }).await;
            let slots = RenderSlots::new(Arc::clone(reg), s.host.now_ns(), Value::UNDEFINED);
            slots.resolved(&refs, resp);
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
