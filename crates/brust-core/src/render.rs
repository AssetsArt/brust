//! minijinja render on tokio (spec §4 S7 steps 6-7, S8, S9).
//!
//! Adapted from `brust-core/src/template/jinja.rs` @ d04718f: the environment is
//! owned by the [`Renderer`] and built once from the manifest's templates (no
//! process-global `RwLock`, no dynamic tier, no hot reload). Every environment
//! goes through [`brust_jinja::register`] — autoescape None, the template writes
//! `| e` itself; no second escaper is ever added here.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use minijinja::Environment;
use serde_json::Value;

use brust_jinja::ctx::Node;

use crate::manifest::{Manifest, Tier};

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("unknown template {0}")]
    Unknown(String),
    /// `msg` is minijinja's Display (`… (in <name>:<line>)`) prefixed with
    /// `line <n>: ` so the line number reaches the server log (spec §7).
    #[error("render {name}: {msg}")]
    Render { name: String, msg: String },
}

fn render_err(name: &str, e: &minijinja::Error) -> RenderError {
    let msg = match e.line() {
        Some(n) => format!("line {n}: {e:#}"),
        None => format!("{e:#}"),
    };
    RenderError::Render {
        name: name.to_string(),
        msg,
    }
}

/// minijinja's builtin `safe` (`Value::from_safe_string(v.to_string())`,
/// the argument taken as a `String`), except that an already-safe string
/// (`__outlet`) is returned as-is instead of copied twice — the value is the
/// same. With `AutoEscape::None` the safe mark never changes a painted byte.
fn safe_filter(
    state: &minijinja::State,
    v: minijinja::Value,
) -> Result<minijinja::Value, minijinja::Error> {
    use minijinja::value::ArgType;
    if v.is_safe() {
        return Ok(v);
    }
    let (s, _) = String::from_state_and_value(Some(state), Some(&v))?;
    Ok(minijinja::Value::from_safe_string(s))
}

/// Documents at least this long are rendered through minijinja's `io::Write`
/// path into the caller's hinted buffer; shorter ones through
/// `Template::render` (its own small buffer beats the Captured cell's box).
const WRITER_MIN: usize = 16 * 1024;

/// Renders `tmpl` into `out` (cleared first) through minijinja's writer path
/// when `out`'s capacity says the document is large (the io::Write adapter +
/// the Captured cell cost a box; a growing String costs log2(n) reallocations
/// of n bytes), else through `render` into a fresh String.
fn render_into(
    tmpl: &minijinja::Template<'_, '_>,
    scope: minijinja::Value,
    out: &mut String,
) -> Result<(), minijinja::Error> {
    out.clear();
    if out.capacity() < WRITER_MIN {
        *out = tmpl.render(scope)?;
        return Ok(());
    }
    let mut buf = std::mem::take(out).into_bytes();
    let r = tmpl.render_captured_to(scope, &mut buf).map(|_| ());
    // SAFETY: minijinja writes whole `&str`s (`Output` → `WriteWrapper::write_str`
    // → `write_all(s.as_bytes())`) and a `Vec<u8>` never fails a write, so `buf`
    // is a concatenation of valid UTF-8 strings at every point, error or not.
    debug_assert!(
        std::str::from_utf8(&buf).is_ok(),
        "minijinja wrote invalid UTF-8"
    );
    *out = unsafe { String::from_utf8_unchecked(buf) };
    r
}

pub struct Renderer {
    env: Environment<'static>,
    /// `brust dev` (L14): wrap each chain level in `<!--brust:<id>-->…<!--/brust-->`, except these ids (react
    /// islands, which React hydrates and which must not get a node injected). `None` = never (production).
    dev_markers: Option<std::collections::HashSet<String>>,
}

impl Renderer {
    /// Builds the environment (`brust_jinja::register`) and compiles every
    /// template. minijinja parses at add time, so a syntax error is returned
    /// here (boot), naming the template and line.
    pub fn from_templates(templates: &BTreeMap<String, String>) -> Result<Self, RenderError> {
        let mut env = Environment::new();
        // One parse at boot: no loader is installed, and auto-reload stays
        // off so a template never re-parses (the M3 dev server owns reload).
        env.set_auto_reload(false);
        brust_jinja::register(&mut env);
        env.add_filter("safe", safe_filter);
        for (id, src) in templates {
            // M3-P P7 (R4): borrowed templates — minijinja 3 reads `borrowed_templates` without a lock;
            // owned ones go through a global Mutex + Arc clone on every get_template. Leaked once per Renderer.
            let name: &'static str = Box::leak(id.clone().into_boxed_str());
            let source: &'static str = Box::leak(src.clone().into_boxed_str());
            env.add_template(name, source)
                .map_err(|e| render_err(id, &e))?;
        }
        Ok(Renderer {
            env,
            dev_markers: None,
        })
    }

    /// Turn on the dev DOM markers (L14); `skip` = component ids that never get one.
    pub fn set_dev_markers(&mut self, skip: std::collections::HashSet<String>) {
        self.dev_markers = Some(skip);
    }

    /// `Environment::get_template` for the render benches (a separate crate, so
    /// `pub(crate)` would not reach them): isolates the lookup from the render.
    #[doc(hidden)]
    pub fn get_template_for_bench(
        &self,
        id: &str,
    ) -> Result<minijinja::Template<'_, '_>, minijinja::Error> {
        self.env.get_template(id)
    }

    pub fn render(&self, name: &str, ctx: &Value) -> Result<String, RenderError> {
        let tmpl = self
            .env
            .get_template(name)
            .map_err(|_| RenderError::Unknown(name.to_string()))?;
        tmpl.render(brust_jinja::value_of(ctx))
            .map_err(|e| render_err(name, &e))
    }

    /// S7 step 7 / S8: leaf-first chain render INTO `out` (cleared first);
    /// each result becomes the parent's `__outlet`. `base` is the merged
    /// context (converted once per request and shared — minijinja `Value`s are
    /// `Arc`-backed); `overlay(id)` returns the layers only that component sees
    /// (its `_idN`, its own child-instance slots and job results, `_props`).
    /// Each component renders under one [`Scope`] object over `base` (M3-P P3):
    /// no per-component map is built. The root template writes straight into
    /// `out` (sized by the caller, M3-P P3); each inner level into a String of
    /// the same capacity hint. Capacity never changes a byte. On an error `out`
    /// may hold a partial render; the caller drops it.
    pub fn render_chain_into(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
        out: &mut String,
    ) -> Result<(), RenderError> {
        out.clear();
        let cap = out.capacity();
        let mut outlet: Option<String> = None;
        for (pos, id) in chain.iter().enumerate().rev() {
            let scope = minijinja::Value::from_object(Scope {
                outlet: outlet.take().map(minijinja::Value::from_safe_string),
                overlay: overlay(id),
                base: base.clone(),
            });
            let tmpl = self
                .env
                .get_template(id)
                .map_err(|_| RenderError::Unknown(id.clone()))?;
            let mark = self
                .dev_markers
                .as_ref()
                .is_some_and(|skip| !skip.contains(id));
            if pos == 0 {
                render_into(&tmpl, scope, out).map_err(|e| render_err(id, &e))?;
                if mark {
                    // After the doctype, never before it: a node ahead of `<!doctype>` puts the page in quirks mode.
                    out.insert_str(doctype_end(out), &format!("<!--brust:{id}-->"));
                    out.push_str("<!--/brust-->");
                }
            } else {
                // An inner level: its output becomes the parent's `__outlet`
                // (an Arc<str> copy inside minijinja — unavoidable); sized like
                // the document, which bounds it.
                let mut s = String::with_capacity(cap);
                render_into(&tmpl, scope, &mut s).map_err(|e| render_err(id, &e))?;
                if mark {
                    s.insert_str(0, &format!("<!--brust:{id}-->"));
                    s.push_str("<!--/brust-->");
                }
                outlet = Some(s);
            }
        }
        Ok(())
    }

    /// [`Self::render_chain_into`] into a fresh String (tests, bench).
    pub fn render_chain_overlay(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
    ) -> Result<String, RenderError> {
        let mut out = String::new();
        self.render_chain_into(chain, base, overlay, &mut out)?;
        Ok(out)
    }

    /// [`Self::render_chain_value`] over a JSON context. Only tests use it;
    /// the pipeline calls [`Self::render_chain_overlay`].
    pub fn render_chain(
        &self,
        chain: &[String],
        ctx: &Value,
        overlay: &dyn Fn(&str) -> Vec<(String, minijinja::Value)>,
    ) -> Result<String, RenderError> {
        self.render_chain_value(chain, &brust_jinja::value_of(ctx), overlay)
    }

    /// [`Self::render_chain_overlay`] with only ad-hoc `(key, value)` pairs per
    /// component (a later pair wins over an earlier one). Only tests use it.
    pub fn render_chain_value(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Vec<(String, minijinja::Value)>,
    ) -> Result<String, RenderError> {
        self.render_chain_overlay(chain, base, &|id| Overlay {
            pairs: overlay(id),
            ..Default::default()
        })
    }
}

/// What one chain component sees over the base context.
#[derive(Debug, Default)]
pub struct Overlay {
    /// Looked up after `maps`, last pair first (`_idN` useId slots; a test's ad-hoc pairs).
    pub pairs: Vec<(String, minijinja::Value)>,
    /// Map-valued layers (`ctx["__children"][id]`, `ctx["__own"][id]`), looked up LAST ONE FIRST.
    pub maps: Vec<minijinja::Value>,
    /// `_props` — beats everything but `__outlet`.
    pub props: Option<minijinja::Value>,
}

/// One chain component's scope: the overlay layers over the base context,
/// as ONE object (M3-P P3) — no `from_pairs` map and no `MergeDict` per
/// component. Lookup order is what `context!{ ..from_pairs(overlay), ..base }`
/// gave (a later pair overwrote an earlier one): `__outlet`, `_props`, the maps
/// last-first (own, children), the pairs last-first (ids), the base. An
/// undefined hit falls through, as `MergeDict` skips it — the one difference
/// from the old shape: an UNDEFINED value in a map layer (an own key) used to
/// shadow the layers below it; here it falls through. `Node` never holds
/// undefined, so production overlays cannot hit it. Root lookups reach
/// `get_value_by_str` directly (no key `Value`).
#[derive(Debug)]
struct Scope {
    outlet: Option<minijinja::Value>,
    overlay: Overlay,
    base: minijinja::Value,
}

fn defined(v: Result<minijinja::Value, minijinja::Error>) -> Option<minijinja::Value> {
    v.ok().filter(|v| !v.is_undefined())
}

impl minijinja::value::Object for Scope {
    fn get_value(self: &Arc<Self>, key: &minijinja::Value) -> Option<minijinja::Value> {
        self.get_value_by_str(key.as_str()?)
    }

    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<minijinja::Value> {
        if key == "__outlet"
            && let Some(o) = &self.outlet
        {
            return Some(o.clone());
        }
        if key == "_props"
            && let Some(p) = &self.overlay.props
        {
            return Some(p.clone());
        }
        for m in self.overlay.maps.iter().rev() {
            if let Some(v) = defined(m.get_attr(key)) {
                return Some(v);
            }
        }
        // The pairs were one map before P3: the last pair for `key` is the
        // entry; an undefined entry falls through to the base, as before.
        if let Some((_, v)) = self.overlay.pairs.iter().rev().find(|(k, _)| k == key)
            && !v.is_undefined()
        {
            return Some(v.clone());
        }
        defined(self.base.get_attr(key))
    }

    fn enumerate(self: &Arc<Self>) -> minijinja::value::Enumerator {
        // The union of the layers' keys, sorted (MergeDict: map-kind layers only).
        let mut keys = std::collections::BTreeSet::new();
        for m in self.overlay.maps.iter().chain(std::iter::once(&self.base)) {
            if m.kind() == minijinja::value::ValueKind::Map
                && let Ok(it) = m.try_iter()
            {
                keys.extend(it);
            }
        }
        keys.extend(
            self.overlay
                .pairs
                .iter()
                .map(|(k, _)| minijinja::Value::from(k.as_str())),
        );
        if self.overlay.props.is_some() {
            keys.insert(minijinja::Value::from("_props"));
        }
        if self.outlet.is_some() {
            keys.insert(minijinja::Value::from("__outlet"));
        }
        minijinja::value::Enumerator::Iter(Box::new(keys.into_iter()))
    }
}

/// [`inject_page_assets_into`] without a store snapshot: S9 injection, byte for byte.
pub fn inject_assets_into(html: &mut String, chain: &[String], m: &Manifest) {
    inject_page_assets_into(html, chain, m, None);
}

/// S9 + M3-F C4/D6: `<script type="module" src="/_brust/<p>">` for runtime, each `client` of
/// the chain + job targets + inlined children (dedup, chain order), then
/// `react` + each react chunk, preceded by one `data-brust-store` tag per store in `store`
/// (the ctx `__store` map, sorted by name: `MapInner` is a BTreeMap), immediately before the
/// runtime tag, so the snapshot is in the DOM before `mount()` and before any island hydrates.
/// L33: a `modulepreload` link per runtime file the page uses goes into the head (see below). No tags at all when every
/// component in the chain (and its children) is `static` (R4).
/// Inserted before the last `</body>`, else appended — in place.
pub fn inject_page_assets_into(
    html: &mut String,
    chain: &[String],
    m: &Manifest,
    store: Option<&Node>,
) {
    inject_document_assets_into(html, chain, m, store, None);
}

/// L19 (R19.3): a `<link rel="stylesheet" href="/_brust/…" data-brust-css>` per entry of the route's
/// `css`, in order, right after the opening `<head>` (or after a `<meta charset>` that comes first in
/// it), so every tag the author wrote in the head follows and wins the cascade. `<header>` is not a
/// head. Without a `<head>` the links go first, after a leading doctype. Not gated by the tier: an
/// all-static page is styled too. The paths were checked at boot (`client/<safe name>.css`).
pub fn inject_css_into(html: &mut String, css: &[String]) {
    if css.is_empty() {
        return;
    }
    let mut links = String::new();
    for p in css {
        links.push_str("<link rel=\"stylesheet\" href=\"/_brust/");
        links.push_str(p);
        links.push_str("\" data-brust-css>");
    }
    let at = css_insert_at(html);
    html.insert_str(at, &links);
}

/// Byte offset the CSS links go to (see [`inject_css_into`]).
fn css_insert_at(html: &str) -> usize {
    let b = html.as_bytes();
    // The end of the tag starting at `i` (one past its `>`), or the end of the text.
    let tag_end = |i: usize| html[i..].find('>').map_or(html.len(), |e| i + e + 1);
    let head = [html.find("<head>"), html.find("<head ")]
        .into_iter()
        .flatten()
        .min();
    let Some(h) = head else {
        let lead = html.len() - html.trim_start().len();
        return if b.len() >= lead + 9 && b[lead..lead + 9].eq_ignore_ascii_case(b"<!doctype") {
            tag_end(lead)
        } else {
            0
        };
    };
    let after = tag_end(h);
    let rest = &html[after..];
    let k = after + (rest.len() - rest.trim_start().len());
    if b.len() >= k + 5 && b[k..k + 5].eq_ignore_ascii_case(b"<meta") {
        let end = tag_end(k);
        if html[k..end].to_ascii_lowercase().contains("charset") {
            return end;
        }
    }
    after
}

/// F392: a full document (its first element, after whitespace and comments, is `<html`) with no leading
/// doctype gets `<!doctype html>` first, so no browser renders it in quirks mode. A React root layout
/// returning `<html>` cannot write a doctype itself. A fragment, or a document that has one, is untouched.
pub fn ensure_doctype(html: &mut String) {
    let b = html.as_bytes();
    let mut i = 0;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b[i..].starts_with(b"<!--") {
            match html[i + 4..].find("-->") {
                Some(e) => i += 4 + e + 3,
                None => return,
            }
        } else {
            break;
        }
    }
    let rest = &b[i..];
    let is_html = rest.len() > 5
        && rest[..5].eq_ignore_ascii_case(b"<html")
        && matches!(
            rest[5],
            b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c'
        );
    if is_html {
        html.insert_str(0, "<!doctype html>");
    }
}

/// Byte offset just past a leading `<!doctype …>` (case-insensitive, after optional whitespace); 0 when the document has none.
fn doctype_end(html: &str) -> usize {
    let lead = html.len() - html.trim_start().len();
    let rest = &html[lead..];
    if rest.len() >= 9
        && rest.as_bytes()[..9].eq_ignore_ascii_case(b"<!doctype")
        && let Some(i) = rest.find('>')
    {
        return lead + i + 1;
    }
    0
}

/// The components a page is made of, in the order the asset injection walks them: each chain level, the react
/// children its jobs target, and its native children (L14 trace).
pub fn page_components(chain: &[String], m: &Manifest) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |id: &str| {
        if !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    };
    for id in chain {
        add(id);
        if let Some(c) = m.components.get(id) {
            for t in c.jobs.iter().filter_map(|j| j.target.as_deref()) {
                add(t);
            }
            for ch in &c.children {
                add(&ch.id);
            }
        }
    }
    out
}

/// M3-F A4: as [`inject_page_assets_into`], with `prefix_tag` (the server's prebuilt
/// `__BRUST_ACTION_PREFIX__` script, only for a non-default prefix) first:
/// `[prefix tag][store tags][runtime]…`; nothing for a static chain (R12).
pub fn inject_document_assets_into(
    html: &mut String,
    chain: &[String],
    m: &Manifest,
    store: Option<&Node>,
    prefix_tag: Option<&str>,
) {
    let mut chunks: Vec<&str> = Vec::new();
    let mut react: Vec<&str> = Vec::new();
    let mut features: BTreeSet<&str> = BTreeSet::new();
    let mut any_dynamic = false;
    let mut visit = |id: &str| {
        if let Some(c) = m.components.get(id) {
            if c.tier != Tier::Static {
                any_dynamic = true;
            }
            features.extend(c.features.iter().map(String::as_str));
            if let Some(cl) = &c.client {
                let bucket = if c.tier == Tier::React {
                    &mut react
                } else {
                    &mut chunks
                };
                if !bucket.contains(&cl.as_str()) {
                    bucket.push(cl);
                }
            }
        }
    };
    for id in chain {
        visit(id);
        if let Some(c) = m.components.get(id) {
            // React children are not child records: their ssr jobs sit in
            // this component's `jobs[]` and name them as `target`.
            for t in c.jobs.iter().filter_map(|j| j.target.as_deref()) {
                visit(t);
            }
            for ch in &c.children {
                visit(&ch.id);
                // An island inside an inlined child is that child's ssr job target (L4).
                if let Some(cc) = m.components.get(&ch.id) {
                    for t in cc.jobs.iter().filter_map(|j| j.target.as_deref()) {
                        visit(t);
                    }
                }
            }
        }
    }
    if !any_dynamic {
        return;
    }
    let tag = |p: &str| format!("<script type=\"module\" src=\"/_brust/{p}\"></script>");
    let mut tags = String::new();
    if let Some(t) = prefix_tag {
        tags.push_str(t);
    }
    if let Some(st) = store {
        store_scripts_into(&mut tags, st);
    }
    tags.push_str(&tag(&m.assets.runtime));
    // L33: the runtime features this page's components need, sorted by name (the core first, then
    // features, then the chunks that define behaviors: module scripts run in document order). A
    // preload-only feature (the store module) is imported by the chunks that use it: no tag of its own.
    let needed: Vec<&str> = m
        .assets
        .features
        .iter()
        .filter(|(name, _)| features.contains(name.as_str()))
        .map(|(name, file)| {
            if !PRELOAD_ONLY.contains(&name.as_str()) {
                tags.push_str(&tag(file));
            }
            file.as_str()
        })
        .collect();
    for c in &chunks {
        tags.push_str(&tag(c));
    }
    if !react.is_empty() {
        if let Some(r) = &m.assets.react {
            tags.push_str(&tag(r));
        }
        for c in &react {
            tags.push_str(&tag(c));
        }
    }
    match html.rfind("</body>") {
        Some(i) => html.insert_str(i, &tags),
        None => html.push_str(&tags),
    }
    // L33 (R35.2): `<link rel="modulepreload">` for the core and every feature module the page uses, in the head
    // (after the route's stylesheet links, before anything the author wrote there), so the browser fetches them
    // while it parses the body instead of discovering the store module and the features through the scripts.
    let mut links = String::new();
    for f in std::iter::once(m.assets.runtime.as_str()).chain(needed) {
        links.push_str("<link rel=\"modulepreload\" href=\"/_brust/");
        links.push_str(f);
        links.push_str("\">");
    }
    // A fragment or a document without a `<head>` gets no links (the scripts still load every module).
    if let Some(at) = preload_insert_at(html) {
        html.insert_str(at, &links);
    }
}

/// Features that are preloaded but not linked as a script: modules the component chunks import themselves.
const PRELOAD_ONLY: &[&str] = &["store"];

/// Where the modulepreload links go: the CSS insertion point, past the stylesheet links `inject_css_into` wrote there;
/// `None` when the document has no `<head>` (a link before `<html>` or in a fragment is not a head link).
fn preload_insert_at(html: &str) -> Option<usize> {
    const CSS: &str = "<link rel=\"stylesheet\" href=\"/_brust/";
    if !html.contains("<head>") && !html.contains("<head ") {
        return None;
    }
    let mut at = css_insert_at(html);
    while html[at..].starts_with(CSS) {
        at = html[at..].find('>').map_or(html.len(), |e| at + e + 1);
    }
    Some(at)
}

/// 0.1.x `storeScriptTag` x each store: `<script type="application/json" data-brust-store="NAME">`
/// followed by script-safe JSON and `</script>`. NAME keeps `[A-Za-z0-9_.:-]` only (an emptied name is
/// skipped); the JSON escapes `< > & U+2028 U+2029` as `\uXXXX` (0.1.x `toScriptJson`;
/// AutoEscape::None and a request-derived value can reach a signal).
pub fn store_scripts_into(out: &mut String, store: &Node) {
    let Node::Map(m) = store else { return };
    for (name, state) in m.0.iter() {
        let clean: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
            .collect();
        if clean.is_empty() {
            tracing::warn!(store = %name, "store name has no [A-Za-z0-9_.:-] character; snapshot not injected");
            continue;
        }
        out.push_str("<script type=\"application/json\" data-brust-store=\"");
        out.push_str(&clean);
        out.push_str("\">");
        let json = serde_json::to_string(state).expect("Node serialises");
        for c in json.chars() {
            match c {
                '<' => out.push_str("\\u003c"),
                '>' => out.push_str("\\u003e"),
                '&' => out.push_str("\\u0026"),
                '\u{2028}' => out.push_str("\\u2028"),
                '\u{2029}' => out.push_str("\\u2029"),
                c => out.push(c),
            }
        }
        out.push_str("</script>");
    }
}

/// [`inject_assets_into`] over an owned String (tests, bench).
pub fn inject_assets(mut html: String, chain: &[String], m: &Manifest) -> String {
    inject_assets_into(&mut html, chain, m);
    html
}

/// S7 step 6 / F39: context keys `_id0`..`_id{slots-1}` (0-based, lead ruling
/// on challenge a76cefb2) carry `brust-<routeId>-<instance>-<n>` for n in 1..=slots;
/// instance = component id for chain entries, `<parentId>.<childId>_<k>` for
/// static child instances, `<parentId>.<childId>_<k>-<row>` for per-row
/// instances. Ids are opaque: stable and unique per route is the contract.
pub fn use_ids(route_id: &str, instance: &str, slots: u32) -> Vec<(String, String)> {
    (1..=slots)
        .map(|n| {
            (
                format!("_id{}", n - 1),
                format!("brust-{route_id}-{instance}-{n}"),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_links_go_right_after_head_never_into_header() {
        let css = vec![
            "client/a-1a2b3c4d5e.css".to_string(),
            "client/b-0a1b2c3d4e.css".to_string(),
        ];
        let links = "<link rel=\"stylesheet\" href=\"/_brust/client/a-1a2b3c4d5e.css\" data-brust-css><link rel=\"stylesheet\" href=\"/_brust/client/b-0a1b2c3d4e.css\" data-brust-css>";
        let run = |html: &str| {
            let mut s = html.to_string();
            inject_css_into(&mut s, &css);
            s
        };
        // The author's own head tags come after brust's links.
        assert_eq!(
            run(
                "<html><head><title>t</title><link rel=\"stylesheet\" href=\"/public/me.css\"></head></html>"
            ),
            format!(
                "<html><head>{links}<title>t</title><link rel=\"stylesheet\" href=\"/public/me.css\"></head></html>"
            )
        );
        assert_eq!(
            run("<head lang=\"x\">\n  <meta charset=\"utf-8\"><title>t</title></head>"),
            format!("<head lang=\"x\">\n  <meta charset=\"utf-8\">{links}<title>t</title></head>")
        );
        // A meta that is not the charset does not move the links.
        assert_eq!(
            run("<head><meta name=\"x\"></head>"),
            format!("<head>{links}<meta name=\"x\"></head>")
        );
        // `<header>` is not a head: no head at all, so the links go first (after a doctype).
        assert_eq!(
            run("<header>h</header><p>x</p>"),
            format!("{links}<header>h</header><p>x</p>")
        );
        assert_eq!(
            run("<!DOCTYPE html><header>h</header>"),
            format!("<!DOCTYPE html>{links}<header>h</header>")
        );
        assert_eq!(
            run("<body><header>h</header><head><title>late</title></head></body>"),
            format!("<body><header>h</header><head>{links}<title>late</title></head></body>")
        );
        let mut none = "<p>x</p>".to_string();
        inject_css_into(&mut none, &[]);
        assert_eq!(none, "<p>x</p>");
    }
    use serde_json::json;

    fn templates(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// The `safe` override paints what minijinja's builtin does, for every
    /// kind of operand, and passes an already-safe `__outlet` through.
    #[test]
    fn safe_filter_paints_like_the_builtin() {
        let src = "{{ s | safe }}|{{ n | safe }}|{{ f | safe }}|{{ z | safe }}|{{ b | safe }}|\
                   {{ missing | safe }}|{{ missing.deep | safe }}|{{ l | safe }}|{{ m | safe }}|\
                   {{ (s | safe) | length }}|{{ __outlet | safe }}|{{ (__outlet | safe) | e }}";
        let ctx = json!({"s": "<b>&", "n": 7, "f": 1.5, "z": null, "b": true,
                         "l": [1, "<a>"], "m": {"k": "v"}});
        let ours = Renderer::from_templates(&templates(&[("T", src)])).unwrap();
        let mut builtin = Environment::new();
        brust_jinja::register(&mut builtin);
        builtin.add_template("T", src).unwrap();
        let want = builtin
            .get_template("T")
            .unwrap()
            .render(minijinja::context! {
                __outlet => minijinja::Value::from("<i>x</i>"),
                ..brust_jinja::value_of(&ctx)
            })
            .unwrap();
        let got = ours
            .render_chain(&["T".into()], &ctx, &|_| {
                vec![(
                    "__outlet".into(),
                    minijinja::Value::from_safe_string("<i>x</i>".into()),
                )]
            })
            .unwrap();
        assert_eq!(got, want);
        assert!(got.contains("<b>&|7|1.5|None|True|||"), "{got}");
    }

    // Adapted from template/jinja.rs `jinja_round_trip` (:243): owned env built
    // from a template map instead of a directory + process-global; the reload
    // and BadJson sub-checks have no subject (no hot reload, ctx is a Value).
    // Adds the overlay semantics of `render_chain`.
    #[test]
    fn jinja_round_trip() {
        let r = Renderer::from_templates(&templates(&[
            ("HelloPage", "<div><h1>Hello, {{ name }}</h1></div>"),
            (
                "ListNav",
                "<ul>{% for item in items %}<li>{{ item.label }}</li>{% endfor %}</ul>",
            ),
            (
                "Layout",
                "[{{ _id1 }}|{{ __outlet | safe }}|{{ missing is defined }}|{{ missing.deep.x | e }}|{{ name | e }}]",
            ),
            ("Leaf", "<{{ _id1 }}:{{ name }}:{{ __outlet is defined }}>"),
        ]))
        .expect("templates");

        let out = r.render("HelloPage", &json!({"name": "World"})).unwrap();
        assert_eq!(out, "<div><h1>Hello, World</h1></div>");

        let out = r
            .render(
                "ListNav",
                &json!({"items": [{"label": "A"}, {"label": "B"}]}),
            )
            .unwrap();
        assert_eq!(out, "<ul><li>A</li><li>B</li></ul>");

        // W1d PR 3: a component that threw while rendering (`render_error`) is a render error, not a page
        let mut templates = std::collections::BTreeMap::new();
        templates.insert(
            "Throws".to_string(),
            "{% if bad %}{{ (none | render_error) | e }}{% else %}ok{% endif %}".to_string(),
        );
        let t = Renderer::from_templates(&templates).unwrap();
        assert_eq!(t.render("Throws", &json!({"bad": false})).unwrap(), "ok");
        match t.render("Throws", &json!({"bad": true})) {
            Err(RenderError::Render { msg, .. }) => {
                assert!(msg.contains("a component threw while rendering"), "{msg}")
            }
            other => panic!("expected a render error, got {other:?}"),
        }

        match r.render("NotThere", &json!({})) {
            Err(RenderError::Unknown(name)) => assert_eq!(name, "NotThere"),
            other => panic!("expected Unknown, got {other:?}"),
        }
        match r.render_chain(&["NotThere".into()], &json!({}), &|_| Vec::new()) {
            Err(RenderError::Unknown(name)) => assert_eq!(name, "NotThere"),
            other => panic!("expected Unknown, got {other:?}"),
        }

        // Overlay wins over the base ctx (`_id1` is in both), per component;
        // a key missing everywhere is undefined and chains (UndefinedBehavior::Chainable).
        let ctx = json!({"name": "<n>", "_id1": "base"});
        let ids = |id: &str| match id {
            "Layout" => vec![("_id1".to_string(), minijinja::Value::from("L1"))],
            "Leaf" => vec![("_id1".to_string(), minijinja::Value::from("F1"))],
            _ => Vec::new(),
        };
        let out = r
            .render_chain(&["Layout".into(), "Leaf".into()], &ctx, &ids)
            .unwrap();
        assert_eq!(out, "[L1|<F1:<n>:False>|False||&lt;n&gt;]");

        // No overlay: the base ctx is used as-is.
        let out = r
            .render_chain(&["Leaf".into()], &ctx, &|_| Vec::new())
            .unwrap();
        assert_eq!(out, "<base:<n>:False>");
        assert_eq!(r.render_chain(&[], &ctx, &|_| Vec::new()).unwrap(), "");
    }

    /// The Scope answers exactly what `context!{ ..from_pairs(overlay), ..base }` answered:
    /// __outlet > _props > own > children > ids > base, undefined skipped, union enumerated.
    #[test]
    fn scope_lookup_order_matches_the_merge_dict() {
        let r = Renderer::from_templates(&templates(&[(
            "T",
            "{{ __outlet | safe }}|{{ _props.x }}|{{ k }}|{{ _id0 }}|{{ only_base }}|{{ gone is defined }}|{% for n in self %}{{ n }},{% endfor %}",
        )]))
        .unwrap();
        let base = minijinja::context! { k => "base", _id0 => "base-id", only_base => "ob", _props => "base-props", x => 1 };
        let children = minijinja::context! { k => "children", gone => minijinja::Value::UNDEFINED };
        let own = minijinja::context! { k => "own" };
        let overlay = Overlay {
            pairs: vec![
                ("_id0".into(), minijinja::Value::from("id")),
                ("k".into(), minijinja::Value::from("ids")),
            ],
            maps: vec![children.clone(), own.clone()],
            props: Some(minijinja::context! { x => 2 }),
        };
        let got = r
            .render_chain_overlay(&["T".into()], &base, &|_| Overlay {
                pairs: overlay.pairs.clone(),
                maps: overlay.maps.clone(),
                props: overlay.props.clone(),
            })
            .unwrap();
        // Reference: the former shape, built the way render_chain_value built it.
        let mut pairs = overlay.pairs.clone();
        for m in [&children, &own] {
            for k in m.try_iter().unwrap() {
                pairs.push((k.to_string(), m.get_item(&k).unwrap()));
            }
        }
        pairs.push(("_props".into(), overlay.props.clone().unwrap()));
        let pairs_ref = pairs.clone();
        let want = minijinja::context! { ..minijinja::Value::from_pairs(pairs), ..base.clone() };
        let want = r.env.get_template("T").unwrap().render(want).unwrap();
        assert_eq!(got, want);
        // minijinja paints a bare bool as `False`; `self` is not the root scope
        // in minijinja 3.0 (the loop paints nothing), so enumeration is pinned
        // below through `try_iter` on the scope object itself.
        assert_eq!(got, "|2|own|id|ob|False|");
        let scope = minijinja::Value::from_object(Scope {
            outlet: Some(minijinja::Value::from_safe_string("o".into())),
            overlay: Overlay {
                pairs: overlay.pairs.clone(),
                maps: overlay.maps.clone(),
                props: overlay.props.clone(),
            },
            base: base.clone(),
        });
        let mut pairs = pairs_ref.clone();
        pairs.push((
            "__outlet".into(),
            minijinja::Value::from_safe_string("o".into()),
        ));
        let merged = minijinja::context! { ..minijinja::Value::from_pairs(pairs), ..base.clone() };
        let keys = |v: &minijinja::Value| {
            v.try_iter()
                .unwrap()
                .map(|k| k.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&scope), keys(&merged));
        assert_eq!(
            keys(&scope),
            ["__outlet", "_id0", "_props", "gone", "k", "only_base", "x"]
        );
    }

    /// A scope sees the context as it was when the scope was built: a later
    /// make_mut write to the Node tree copies, it does not reach the view.
    #[test]
    fn scope_sees_the_context_as_rendered_not_as_later_mutated() {
        use brust_jinja::ctx::Node;
        let r = Renderer::from_templates(&templates(&[("T", "{{ a.b }}")])).unwrap();
        let mut ctx: Node = serde_json::from_str(r#"{"a":{"b":1}}"#).unwrap();
        let base = ctx.to_value();
        ctx.get_mut_path(&["a"])
            .unwrap()
            .map_mut()
            .unwrap()
            .insert("b".into(), Node::Num(2.into()));
        assert_eq!(
            r.render_chain_overlay(&["T".into()], &base, &|_| Overlay::default())
                .unwrap(),
            "1"
        );
        assert_eq!(
            r.render_chain_overlay(&["T".into()], &ctx.to_value(), &|_| Overlay::default())
                .unwrap(),
            "2"
        );
    }

    #[test]
    fn render_chain_into_clears_and_never_depends_on_capacity() {
        let r = Renderer::from_templates(&templates(&[
            ("L", "<html><body>{{ __outlet | safe }}</body></html>"),
            ("P", "{% for i in range(n) %}<p>{{ i }}</p>{% endfor %}"),
        ]))
        .unwrap();
        let chain = ["L".to_string(), "P".to_string()];
        let big = minijinja::context! { n => 4000 }; // > WRITER_MIN bytes
        let small = minijinja::context! { n => 3 };
        let want_big = r
            .render_chain_overlay(&chain, &big, &|_| Overlay::default())
            .unwrap();
        let want_small = r
            .render_chain_overlay(&chain, &small, &|_| Overlay::default())
            .unwrap();
        assert!(want_big.len() > WRITER_MIN && want_small.len() < WRITER_MIN);
        // A then B into ONE buffer: B exact (no stale tail), whatever the capacity.
        for cap in [0usize, 100, WRITER_MIN, 1 << 20] {
            let mut out = String::with_capacity(cap);
            r.render_chain_into(&chain, &big, &|_| Overlay::default(), &mut out)
                .unwrap();
            assert_eq!(out, want_big, "cap {cap}");
            r.render_chain_into(&chain, &small, &|_| Overlay::default(), &mut out)
                .unwrap();
            assert_eq!(out, want_small, "cap {cap}");
        }
        // A junk-filled buffer is cleared first.
        let mut out = "JUNK".repeat(10_000);
        r.render_chain_into(&chain, &big, &|_| Overlay::default(), &mut out)
            .unwrap();
        assert_eq!(out, want_big);
        // An error leaves nothing of the failed render in the caller's hands.
        let mut out = String::new();
        assert!(matches!(
            r.render_chain_into(&["Nope".into()], &big, &|_| Overlay::default(), &mut out),
            Err(RenderError::Unknown(_))
        ));
    }

    #[test]
    fn inject_assets_into_equals_inject_assets() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../brust-server/tests/fixtures/dist");
        let m = crate::manifest::Manifest::load(&dir).unwrap().manifest;
        // routes[0] is all-static (no tags); routes[1] has a native page (tags).
        for route in &m.routes[..2] {
            let chain: Vec<String> = route.chain.clone();
            for html in [
                "<html><body><p>x</p></body></html>",
                "<p>no body tag</p>",
                "<body></body><body></body>",
                "",
            ] {
                let want = inject_assets(html.to_string(), &chain, &m);
                let mut got = String::with_capacity(4096);
                got.push_str(html);
                inject_assets_into(&mut got, &chain, &m);
                assert_eq!(got, want, "{} {html:?}", route.id);
            }
        }
        assert_ne!(
            inject_assets(String::new(), &m.routes[1].chain, &m),
            "",
            "routes[1] must exercise the tag path"
        );
    }

    #[test]
    fn inject_links_core_then_exactly_the_features_the_chain_needs() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../brust-server/tests/fixtures/dist");
        let mut m = crate::manifest::Manifest::load(&dir).unwrap().manifest;
        for f in ["basics", "for", "island", "store"] {
            m.assets
                .features
                .insert(f.into(), format!("client/rt-{f}-0123456789.js"));
        }
        let chain = m.routes[1].chain.clone();
        let preloads = |out: &str| out.matches("rel=\"modulepreload\"").count();
        // No component asks for a feature: the core is preloaded and linked, nothing else of the rt-* family.
        let bare = inject_assets("<html><head></head><body></body></html>".into(), &chain, &m);
        assert!(!bare.contains("rt-"), "{bare}");
        assert_eq!(preloads(&bare), 1, "{bare}");
        // A fragment (no `<head>`) gets the scripts and no links.
        let frag = inject_assets(String::new(), &chain, &m);
        assert_eq!(preloads(&frag), 0, "{frag}");
        assert!(frag.contains("<script type=\"module\""), "{frag}");
        // One component asks for basics and the store: basics is preloaded and linked once (after the core,
        // before the chunks); the store module is preloaded only (the chunks that use it import it).
        let id = chain
            .iter()
            .find(|c| m.components[c.as_str()].tier != Tier::Static)
            .unwrap()
            .clone();
        m.components.get_mut(&id).unwrap().features = vec!["basics".into(), "store".into()];
        let out = inject_assets("<html><head></head><body></body></html>".into(), &chain, &m);
        assert_eq!(out.matches("rt-basics-0123456789.js").count(), 2, "{out}"); // preload + script
        assert_eq!(out.matches("rt-store-0123456789.js").count(), 1, "{out}"); // preload only
        assert!(
            !out.contains("rt-for-") && !out.contains("rt-island-"),
            "{out}"
        );
        assert_eq!(preloads(&out), 3, "{out}"); // core, basics, store
        assert!(
            out.contains(&format!(
                "<link rel=\"modulepreload\" href=\"/_brust/{}\">",
                m.assets.runtime
            )),
            "{out}"
        );
        // The links sit in the head, before the first module script.
        let at = |needle: &str| out.find(needle).unwrap();
        assert!(
            at("modulepreload") > at("<head>") && at("modulepreload") < at("</head>"),
            "{out}"
        );
        assert!(
            at("rel=\"modulepreload\"") < at("<script type=\"module\""),
            "{out}"
        );
        let script = |f: &str| format!("<script type=\"module\" src=\"/_brust/{f}\">");
        assert!(
            at(&script(&m.assets.runtime)) < at(&script("client/rt-basics-0123456789.js")),
            "{out}"
        );
        if let Some(chunk) = &m.components[&id].client {
            assert!(
                at(&script("client/rt-basics-0123456789.js")) < at(&script(chunk)),
                "{out}"
            );
        }
    }

    #[test]
    fn preload_links_follow_the_route_stylesheets_in_the_head() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../brust-server/tests/fixtures/dist");
        let m = crate::manifest::Manifest::load(&dir).unwrap().manifest;
        let chain = m.routes[1].chain.clone();
        let mut html = "<html><head><title>t</title></head><body></body></html>".to_string();
        inject_css_into(&mut html, &["client/a-0123456789.css".to_string()]);
        inject_assets_into(&mut html, &chain, &m);
        let css = html.find("data-brust-css").unwrap();
        let pre = html.find("modulepreload").unwrap();
        assert!(css < pre && pre < html.find("<title>").unwrap(), "{html}");
    }

    // ---- L14: dev markers and the doctype ----

    #[test]
    fn doctype_end_finds_a_leading_doctype_only() {
        assert_eq!(doctype_end("<!doctype html><html>"), 15);
        assert_eq!(doctype_end("  <!DOCTYPE html>\n<html>"), 17);
        assert_eq!(doctype_end("<html><!doctype html>"), 0);
        assert_eq!(doctype_end("<!-- c --><!doctype html>"), 0);
        assert_eq!(doctype_end("<!doctype html"), 0);
        assert_eq!(doctype_end(""), 0);
    }

    #[test]
    fn ensure_doctype_writes_one_for_a_full_document_only() {
        let run = |s: &str| {
            let mut h = s.to_string();
            ensure_doctype(&mut h);
            h
        };
        assert_eq!(
            run("\n<html lang=\"th\"><body></body></html>"),
            "<!doctype html>\n<html lang=\"th\"><body></body></html>"
        );
        assert_eq!(
            run("<!-- a --> <!--b-->\n<HTML>"),
            "<!doctype html><!-- a --> <!--b-->\n<HTML>"
        );
        assert_eq!(
            run("<!--brust:root--><html></html>"),
            "<!doctype html><!--brust:root--><html></html>"
        );
        // already has one (any case, leading whitespace), or is a fragment, or not an <html> element
        for same in [
            "<!doctype html><html>",
            "  <!DOCTYPE html>\n<html>",
            "<!-- c --><!doctype html><html>",
            "<div>x</div>",
            "<header>h</header>",
            "<htmlx>",
            "<html",
            "",
            "  ",
            "<!-- open",
        ] {
            assert_eq!(run(same), same, "{same:?}");
        }
    }

    #[test]
    fn dev_markers_wrap_each_level_and_sit_after_the_doctype() {
        let mut r = Renderer::from_templates(&templates(&[
            (
                "root",
                "<!doctype html><html><body>{{ __outlet | safe }}</body></html>",
            ),
            ("leaf", "<p>x</p>"),
            ("isl", "<brust-island>i</brust-island>"),
        ]))
        .unwrap();
        let chain: Vec<String> = vec!["root".into(), "leaf".into()];
        let plain = r
            .render_chain(&chain, &serde_json::json!({}), &|_| vec![])
            .unwrap();
        assert!(!plain.contains("<!--brust"));
        r.set_dev_markers(["isl".to_string()].into());
        let dev = r
            .render_chain(&chain, &serde_json::json!({}), &|_| vec![])
            .unwrap();
        assert!(
            dev.starts_with("<!doctype html><!--brust:root--><html>"),
            "{dev}"
        );
        assert!(
            dev.contains("<body><!--brust:leaf--><p>x</p><!--/brust--></body>"),
            "{dev}"
        );
        assert!(dev.ends_with("</html><!--/brust-->"), "{dev}");
        // a react level (in the skip set) is never wrapped
        let isl = r
            .render_chain(&["isl".to_string()], &serde_json::json!({}), &|_| vec![])
            .unwrap();
        assert_eq!(isl, "<brust-island>i</brust-island>");
    }
}
