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
        Ok(Renderer { env })
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
    /// may hold a partial render; the caller drops it. Every level is marked
    /// (see [`Self::render_chain_marked`]); the root's `<id>:<hash>` is dropped.
    pub fn render_chain_into(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
        out: &mut String,
    ) -> Result<(), RenderError> {
        self.render_chain_marked(chain, base, overlay, &|_| false, out)
            .map(|_| ())
    }

    /// F453: [`Self::render_chain_into`] with the SPA-navigation level markers (design §5.9). Every inner level
    /// (`pos > 0`) is wrapped in `<!--brust-l:<id>:<hash>-->…<!--/brust-l:<id>-->`, where `<hash>` covers that
    /// level's OWN markup (its output with the child level left out; for the root also without `<head>…</head>`).
    /// The root is not wrapped: its `<id>:<hash>` is returned, for the `nav` tag's `data-brust-root`.
    ///
    /// `unmarked(id)` is true for a level that must get no node (a react island, which React hydrates as written).
    /// A level is marked only while it and every level above it is markable (an id that cannot sit in a comment
    /// is not): markers inside an unmarked level's output would sit in markup that is not ours to touch, and a
    /// chain with a hole in it is not a chain the client can walk. No marked root: `None`.
    pub fn render_chain_marked(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
        unmarked: &dyn Fn(&str) -> bool,
        out: &mut String,
    ) -> Result<Option<String>, RenderError> {
        out.clear();
        let cap = out.capacity();
        let marked = chain
            .iter()
            .take_while(|id| marker_safe(id) && !unmarked(id))
            .count();
        let mut root = None;
        let mut outlet: Option<minijinja::Value> = None;
        for (pos, id) in chain.iter().enumerate().rev() {
            let child = outlet.take();
            let scope = minijinja::Value::from_object(Scope {
                outlet: child.clone(),
                overlay: overlay(id),
                base: base.clone(),
            });
            let tmpl = self
                .env
                .get_template(id)
                .map_err(|_| RenderError::Unknown(id.clone()))?;
            let mark = pos < marked;
            if pos == 0 {
                render_into(&tmpl, scope, out).map_err(|e| render_err(id, &e))?;
                if mark {
                    let hash = level_hash(out, child.as_ref().and_then(|c| c.as_str()), true);
                    root = Some(format!("{id}:{hash}"));
                }
            } else {
                // An inner level: its output becomes the parent's `__outlet`
                // (an Arc<str> copy inside minijinja — unavoidable); sized like
                // the document, which bounds it.
                let mut s = String::with_capacity(cap);
                render_into(&tmpl, scope, &mut s).map_err(|e| render_err(id, &e))?;
                if mark {
                    let hash = level_hash(&s, child.as_ref().and_then(|c| c.as_str()), false);
                    s.insert_str(0, &format!("<!--brust-l:{id}:{hash}-->"));
                    s.push_str(&format!("<!--/brust-l:{id}-->"));
                }
                outlet = Some(minijinja::Value::from_safe_string(s));
            }
        }
        Ok(root)
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

/// Whether `id` can be written into a `brust-l` comment and a `data-brust-root` attribute as is: printable ASCII
/// without `< > " \' & \``, no `--` (it would end the comment early) and no trailing `-` (`--->` ends it with a
/// stray dash). A chain id is a component id the build chose, not user input; this is the belt for the braces.
fn marker_safe(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_graphic() && !matches!(b, b'<' | b'>' | b'"' | b'\'' | b'&' | b'`'))
        && !id.contains("--")
        && !id.ends_with('-')
}

/// F453: the shell hash of one chain level (design §5.9): 64 bits of blake3 (stable across processes, targets and
/// Rust versions) over the level's own markup, as 16 hex digits. `child` (the `__outlet` string, wherever the
/// template put it) is left out, and for the root so is `<head>…</head>` (the head is reconciled on its own).
/// Each kept segment is length-prefixed, so a child moved from one spot to another changes the hash.
fn level_hash(html: &str, child: Option<&str>, root: bool) -> String {
    let mut cut: Vec<(usize, usize)> = Vec::new();
    if let Some(c) = child.filter(|c| !c.is_empty()) {
        cut.extend(html.match_indices(c).map(|(i, m)| (i, i + m.len())));
    }
    if root && let Some(r) = head_range(html) {
        cut.push(r);
    }
    cut.sort_unstable();
    let mut h = blake3::Hasher::new();
    let mut seg = |s: &str| {
        h.update(&(s.len() as u64).to_le_bytes());
        h.update(s.as_bytes());
    };
    let mut at = 0;
    for (a, b) in cut {
        if b <= at {
            continue;
        }
        seg(&html[at..a.max(at)]);
        at = b;
    }
    seg(&html[at..]);
    h.finalize().to_hex().as_str()[..16].to_string()
}

/// The byte range of the first `<head …>…</head>` element (not `<header>`), end tag included.
fn head_range(html: &str) -> Option<(usize, usize)> {
    let b = html.as_bytes();
    let mut from = 0;
    let start = loop {
        let i = find_ci(html, "<head", from)?;
        if matches!(
            b.get(i + 5),
            Some(b'>' | b'/') | Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
        ) {
            break i;
        }
        from = i + 5;
    };
    let end = find_ci(html, "</head>", start)? + "</head>".len();
    Some((start, end))
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

/// F399: React 19 parity. A `<title>`, a `<meta>` and a `<link>` (not a stylesheet) that a component rendered outside
/// `<head>` are moved into it, in render order, just before `</head>`, and the body copy is removed: React writes the
/// hoistables after the `<head>` element's own children. One with `itemprop` is page content and stays, so does anything
/// inside `<svg>`/`<math>` (an SVG `<title>` is the graphic's name), `<template>`, `<script>`, `<style>`, `<textarea>`,
/// a comment, or a `<brust-island>` (its markup is React's own and hydrates as written). A fragment, and a document with
/// no `</head>`, are untouched. Brust does not dedupe: like React, a layout `<title>` in the head stays too.
pub fn hoist_head_into(html: &mut String) {
    let Some(head_end) = find_ci(html, "</head>", 0) else {
        return;
    };
    let from = head_end + "</head>".len();
    let tail = &html[from..];
    if !(tail.contains("<title") || tail.contains("<meta") || tail.contains("<link")) {
        return;
    }
    let b = html.as_bytes();
    let mut kept = String::with_capacity(html.len() - from);
    let mut hoisted = String::new();
    // The elements whose content is not hoisted from, innermost last: (tag, open depth of that tag name).
    let mut skip: Vec<(String, u32)> = Vec::new();
    let mut i = from;
    let mut copied = from;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"<!--") {
            i = html[i + 4..].find("-->").map_or(b.len(), |e| i + 4 + e + 3);
            continue;
        }
        let closing = b.get(i + 1) == Some(&b'/');
        let name_at = i + 1 + usize::from(closing);
        let name_end = (name_at..b.len())
            .find(|&k| !(b[k].is_ascii_alphanumeric() || b[k] == b'-'))
            .unwrap_or(b.len());
        let name = html[name_at..name_end].to_ascii_lowercase();
        let Some(end) = tag_end(html, name_end) else {
            break;
        };
        let self_closing = html[i..end].ends_with("/>");
        let void = matches!(
            name.as_str(),
            "area"
                | "base"
                | "br"
                | "col"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "source"
                | "track"
                | "wbr"
        );
        // Inside a skipped element, count its own tag name so the matching end tag is the one that ends the skip.
        if let Some(top) = skip.last_mut()
            && top.0 == name
        {
            if closing {
                top.1 -= 1;
                if top.1 == 0 {
                    skip.pop();
                }
                i = end;
                continue;
            }
            if !void && !self_closing {
                top.1 += 1;
                i = end;
                continue;
            }
        }
        const OPAQUE: [&str; 8] = [
            "svg",
            "math",
            "template",
            "script",
            "style",
            "textarea",
            "brust-island",
            "noscript",
        ];
        let raw_text = matches!(name.as_str(), "script" | "style" | "textarea");
        // F399 review: what brust binds or toggles on the client stays where the instance walks it, so the content of
        // an `x-if`/`x-for` element and of a `<brust-if>`/`<brust-row>` wrapper is not hoisted from.
        let dynamic = !closing
            && !void
            && !self_closing
            && (matches!(name.as_str(), "brust-if" | "brust-row")
                || find_attr(&html[i..end], |k| {
                    k.eq_ignore_ascii_case("x-if") || k.eq_ignore_ascii_case("x-for")
                })
                .is_some());
        if !closing && raw_text && !self_closing {
            // script/style/textarea hold raw text up to their own end tag.
            let at = find_ci(html, &format!("</{name}"), end).unwrap_or(b.len());
            i = tag_end(html, at).unwrap_or(b.len());
            continue;
        }
        if !closing && !self_closing && (dynamic || OPAQUE.contains(&name.as_str())) {
            skip.push((name, 1));
            i = end;
            continue;
        }
        if closing || !skip.is_empty() || !matches!(name.as_str(), "title" | "meta" | "link") {
            i = end;
            continue;
        }
        let tag = &html[i..end];
        // React 19 hoists a title or meta with no `itemprop`, a link with a `rel` and an `href` that is not a
        // stylesheet. Anything brust binds (`x-…`) is not inert markup and stays.
        let hoistable = !has_attr(tag, "itemprop")
            && find_attr(tag, |k| k.len() > 2 && k[..2].eq_ignore_ascii_case("x-")).is_none()
            && (name != "link"
                || (attr_value(tag, "rel").is_some_and(|r| {
                    !r.is_empty() && !r.to_ascii_lowercase().contains("stylesheet")
                }) && attr_value(tag, "href").is_some_and(|h| !h.is_empty())));
        let mut stop = end;
        if name == "title" {
            // The title's text runs to its end tag (raw text: no tags inside).
            stop = find_ci(html, "</title", end)
                .and_then(|e| tag_end(html, e))
                .unwrap_or(end);
        }
        if hoistable {
            kept.push_str(&html[copied..i]);
            hoisted.push_str(&html[i..stop]);
            copied = stop;
        }
        i = stop;
    }
    if hoisted.is_empty() {
        return;
    }
    kept.push_str(&html[copied..]);
    html.truncate(from);
    html.push_str(&kept);
    html.insert_str(head_end, &hoisted);
}

/// Byte offset just past the `>` closing the tag whose name ends at `from`, skipping quoted attribute values.
fn tag_end(html: &str, from: usize) -> Option<usize> {
    let b = html.as_bytes();
    let mut quote = 0u8;
    for (k, &c) in b.iter().enumerate().skip(from) {
        match (quote, c) {
            (0, b'"' | b'\'') => quote = c,
            (q, c) if q != 0 && q == c => quote = 0,
            (0, b'>') => return Some(k + 1),
            _ => {}
        }
    }
    None
}

/// Index of the ASCII-case-insensitive `needle` in `html` at or after `from`.
fn find_ci(html: &str, needle: &str, from: usize) -> Option<usize> {
    let (h, n) = (html.as_bytes(), needle.as_bytes());
    if h.len() < n.len() {
        return None;
    }
    (from..=h.len() - n.len()).find(|&k| h[k..k + n.len()].eq_ignore_ascii_case(n))
}

/// The value of attribute `name` (case-insensitive) in an opening tag, `Some("")` when it has none.
fn attr_value<'t>(tag: &'t str, name: &str) -> Option<&'t str> {
    find_attr(tag, |k| k.eq_ignore_ascii_case(name))
}

/// The value of the first attribute of an opening tag whose name `want` accepts.
fn find_attr(tag: &str, want: impl Fn(&str) -> bool) -> Option<&str> {
    let b = tag.as_bytes();
    let mut i = tag.find(|c: char| c.is_ascii_whitespace())?;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if b.get(i) == Some(&b'>') {
            break;
        }
        let s = i;
        while i < b.len() && !matches!(b[i], b'=' | b'>' | b'/') && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == s && b.get(i) == Some(&b'=') {
            i += 1; // a stray `=`: no name to take
            continue;
        }
        let key = &tag[s..i];
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut val = "";
        if b.get(i) == Some(&b'=') {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            match b.get(i) {
                Some(&q @ (b'"' | b'\'')) => {
                    let e = tag[i + 1..].find(q as char).map_or(b.len(), |e| i + 1 + e);
                    val = &tag[i + 1..e];
                    i = e + 1;
                }
                _ => {
                    let s = i;
                    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                        i += 1;
                    }
                    val = &tag[s..i];
                }
            }
        }
        if !key.is_empty() && want(key) {
            return Some(val);
        }
    }
    None
}

fn has_attr(tag: &str, name: &str) -> bool {
    attr_value(tag, name).is_some()
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
/// `[nav tag][prefix tag][store tags][runtime]…`; nothing but the nav tag for a static chain (R12). No root mark
/// (see [`inject_document_assets_with_root_into`]): the nav tag carries no `data-brust-root`.
pub fn inject_document_assets_into(
    html: &mut String,
    chain: &[String],
    m: &Manifest,
    store: Option<&Node>,
    prefix_tag: Option<&str>,
) {
    inject_document_assets_with_root_into(html, chain, m, store, prefix_tag, None);
}

/// F453: the `nav` module's tag, `<script type="module" src="/_brust/<assets.nav>" data-brust-nav
/// data-brust-build="<build id>" data-brust-root="<id>:<hash>">`, goes first among the body-end scripts of every
/// full document (one with a `</body>`), BEFORE the all-static early exit: a page that loads no runtime still
/// navigates. A fragment gets none. `root` is [`Renderer::render_chain_marked`]'s mark of the root level; none
/// (a react root, an older caller) leaves `data-brust-root` off and the client swaps the whole body. A manifest
/// without `assets.nav` emits no tag.
pub fn inject_document_assets_with_root_into(
    html: &mut String,
    chain: &[String],
    m: &Manifest,
    store: Option<&Node>,
    prefix_tag: Option<&str>,
    root: Option<&str>,
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
    let mut tags = String::new();
    if let Some(nav) = &m.assets.nav
        && html.rfind("</body>").is_some()
    {
        tags.push_str("<script type=\"module\" src=\"/_brust/");
        tags.push_str(nav);
        tags.push_str("\" data-brust-nav data-brust-build=\"");
        tags.push_str(m.assets.build.as_deref().unwrap_or_default());
        tags.push('"');
        if let Some(r) = root {
            tags.push_str(" data-brust-root=\"");
            tags.push_str(r);
            tags.push('"');
        }
        tags.push_str("></script>");
    }
    if !any_dynamic {
        if !tags.is_empty() {
            let at = html.rfind("</body>").unwrap_or(html.len());
            html.insert_str(at, &tags);
        }
        return;
    }
    let tag = |p: &str| format!("<script type=\"module\" src=\"/_brust/{p}\"></script>");
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

    /// `html` without the `brust-l` level markers (the comments F453 adds around inner levels).
    fn unmarked(html: &str) -> String {
        let mut out = String::new();
        let mut rest = html;
        while let Some(i) = rest.find("<!--") {
            let after = &rest[i + 4..];
            let end = after.find("-->").map_or(rest.len(), |e| i + 4 + e + 3);
            if after.starts_with("brust-l:") || after.starts_with("/brust-l:") {
                out.push_str(&rest[..i]);
            } else {
                out.push_str(&rest[..end]);
            }
            rest = &rest[end..];
        }
        out.push_str(rest);
        out
    }

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
        assert_eq!(unmarked(&out), "[L1|<F1:<n>:False>|False||&lt;n&gt;]");

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

    // ---- F399: head hoist ----

    fn hoist(html: &str) -> String {
        let mut h = html.to_string();
        hoist_head_into(&mut h);
        h
    }

    /// F399: React 19 writes the head's own children first, then every hoistable in render order.
    #[test]
    fn hoist_moves_title_meta_link_into_the_head_in_render_order() {
        assert_eq!(
            hoist(
                "<html><head><title>Site</title></head><body><main><title>Page</title><meta name=\"description\" content=\"d\"><link rel=\"icon\" href=\"/i.png\"><p>x</p></main></body></html>"
            ),
            "<html><head><title>Site</title><title>Page</title><meta name=\"description\" content=\"d\"><link rel=\"icon\" href=\"/i.png\"></head><body><main><p>x</p></main></body></html>"
        );
    }

    #[test]
    fn hoist_leaves_what_react_leaves() {
        for keep in [
            // an svg title names the graphic
            "<html><head></head><body><svg><title>t</title></svg></body></html>",
            // microdata is content
            "<html><head></head><body><meta itemprop=\"x\" content=\"k\"><link itemprop=\"y\" href=\"/z\"></body></html>",
            // a stylesheet keeps today's handling
            "<html><head></head><body><link rel=\"stylesheet\" href=\"/a.css\"></body></html>",
            // raw text, templates, comments, islands and attribute values are not markup
            "<html><head></head><body><script>var s = '<title>x</title>'</script><style>/*<meta>*/</style><template><title>t</title></template><!-- <title>c</title> --><textarea><title>q</title></textarea><brust-island data-id=\"i\"><title>t</title></brust-island><p data-x=\"<title>a</title>\">p</p></body></html>",
            // a fragment and a document with no head
            "<main><title>t</title></main>",
            "<html><body><title>t</title></body></html>",
        ] {
            assert_eq!(hoist(keep), keep, "{keep}");
        }
    }

    #[test]
    fn hoist_takes_a_title_next_to_an_svg_and_reads_quoted_gt() {
        assert_eq!(
            hoist(
                "<html><head></head><body><svg><title>s</title></svg><title>T</title><meta name=\"a\" content=\"x>y\"></body></html>"
            ),
            "<html><head><title>T</title><meta name=\"a\" content=\"x>y\"></head><body><svg><title>s</title></svg></body></html>"
        );
        // attribute names and the tag's own spelling are case-insensitive; a link without rel is not a stylesheet
        assert_eq!(
            hoist(
                "<html><head></head><body><TITLE>T</TITLE><link HREF=\"/a\" ITEMPROP=\"q\"><meta NAME=\"n\"></body></html>"
            ),
            "<html><head><TITLE>T</TITLE><meta NAME=\"n\"></head><body><link HREF=\"/a\" ITEMPROP=\"q\"></body></html>"
        );
    }

    /// F399 review: markup brust binds or toggles stays where the instance walks it.
    #[test]
    fn hoist_leaves_bound_and_conditional_markup_in_place() {
        for keep in [
            // a reactive title, and both copies of a conditional meta (the hidden one is a template)
            "<html><head></head><body><main x-data=\"t1\"><title x-text=\"_c1\">Count 0</title><!--x-if--><meta x-if=\"_c2\" hidden name=\"description\" content=\"open\"><meta x-if=\"_c2_not\" name=\"description\" content=\"closed\"></main></body></html>",
            // an x-for zero-row template and a <brust-if> copy hold hoistables inside
            "<html><head></head><body><ul><!--x-for--><li x-for=\"r in _l1 by _k1\" hidden><title>row</title></li></ul><brust-if x-if=\"_c3\" hidden><title>a</title><meta name=\"b\" content=\"c\"></brust-if></body></html>",
            // nested same-named elements inside a skipped one do not end the skip early
            "<html><head></head><body><div x-if=\"_c4\"><div><title>deep</title></div><title>t</title></div></body></html>",
            // a link needs a rel and an href (React renders it in place otherwise)
            "<html><head></head><body><link href=\"/a\"><link rel=\"icon\"><link rel=\"icon\" href=\"\"></body></html>",
        ] {
            assert_eq!(hoist(keep), keep, "{keep}");
        }
        // what follows the skipped element is hoisted again
        assert_eq!(
            hoist(
                "<html><head></head><body><div x-if=\"_c\"><div></div><title>no</title></div><title>yes</title></body></html>"
            ),
            "<html><head><title>yes</title></head><body><div x-if=\"_c\"><div></div><title>no</title></div></body></html>"
        );
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

    // ---- F453: level markers, shell hashes, the nav tag ----

    /// `(root, inner, leaf)` templates: the root and the inner layout each write their own markup around `__outlet`.
    fn three_levels(root_body: &str) -> Renderer {
        Renderer::from_templates(&templates(&[
            (
                "root",
                &format!(
                    "<!doctype html><html><head><title>{{{{ t }}}}</title></head><body>{root_body}{{{{ __outlet | safe }}}}</body></html>"
                ),
            ),
            ("mid", "<main>{{ __outlet | safe }}</main>"),
            ("leaf", "<p>{{ n }}</p>"),
        ]))
        .unwrap()
    }

    fn chain3() -> Vec<String> {
        vec!["root".into(), "mid".into(), "leaf".into()]
    }

    fn mark(r: &Renderer, ctx: serde_json::Value) -> (String, Option<String>) {
        let mut out = String::new();
        let root = r
            .render_chain_marked(
                &chain3(),
                &brust_jinja::value_of(&ctx),
                &|_| Overlay::default(),
                &|_| false,
                &mut out,
            )
            .unwrap();
        (out, root)
    }

    /// The `<hash>` of the `brust-l:<id>:` marker of `id`.
    fn hash_of(html: &str, id: &str) -> String {
        let key = format!("<!--brust-l:{id}:");
        let at = html
            .find(&key)
            .unwrap_or_else(|| panic!("no marker for {id}: {html}"))
            + key.len();
        html[at..at + 16].to_string()
    }

    #[test]
    fn level_markers_wrap_each_inner_level_and_the_root_is_passed_out() {
        let r = three_levels("");
        let (html, root) = mark(&r, serde_json::json!({"t": "T", "n": 1}));
        let (mid, leaf) = (hash_of(&html, "mid"), hash_of(&html, "leaf"));
        assert_eq!(
            html,
            format!(
                "<!doctype html><html><head><title>T</title></head><body>\
                 <!--brust-l:mid:{mid}--><main><!--brust-l:leaf:{leaf}--><p>1</p><!--/brust-l:leaf--></main><!--/brust-l:mid-->\
                 </body></html>"
            )
        );
        // The root is not wrapped: its mark goes to the nav tag, and the doctype stays the first thing.
        let root = root.unwrap();
        assert!(
            root.starts_with("root:") && root.len() == "root:".len() + 16,
            "{root}"
        );
        // The plain entry point marks too (the dev markers are gone).
        let plain = r
            .render_chain(
                &chain3(),
                &serde_json::json!({"t": "T", "n": 1}),
                &|_| vec![],
            )
            .unwrap();
        assert_eq!(plain, html);
    }

    #[test]
    fn a_level_hash_ignores_the_child_and_the_head_and_sees_a_one_byte_change() {
        let r = three_levels("<nav>a</nav>");
        let (a, root_a) = mark(&r, serde_json::json!({"t": "T", "n": 1}));
        // Another page under the same layouts, and another head: every layout level keeps its hash.
        let (b, root_b) = mark(&r, serde_json::json!({"t": "Other title", "n": 2}));
        assert_ne!(a, b);
        assert_eq!(hash_of(&a, "mid"), hash_of(&b, "mid"));
        assert_eq!(
            root_a, root_b,
            "the head and the child are not the root's own markup"
        );
        // The page level hashes its own markup: a change in it changes its hash.
        assert_ne!(hash_of(&a, "leaf"), hash_of(&b, "leaf"));
        // A one-byte change in the root's own markup changes the root hash (and not the inner level's).
        let (c, root_c) = mark(
            &three_levels("<nav>b</nav>"),
            serde_json::json!({"t": "T", "n": 1}),
        );
        assert_ne!(root_a, root_c);
        assert_eq!(hash_of(&a, "mid"), hash_of(&c, "mid"));
        // ... also in the body outside the head, and in an inner level.
        let r2 = Renderer::from_templates(&templates(&[
            (
                "root",
                "<html><head></head><body>{{ __outlet | safe }}</body></html>",
            ),
            (
                "mid",
                "<main class=\"{{ c }}\">{{ __outlet | safe }}</main>",
            ),
            ("leaf", "<p>x</p>"),
        ]))
        .unwrap();
        let run = |c: &str| {
            let mut o = String::new();
            r2.render_chain_marked(
                &chain3(),
                &brust_jinja::value_of(&serde_json::json!({ "c": c })),
                &|_| Overlay::default(),
                &|_| false,
                &mut o,
            )
            .unwrap();
            o
        };
        assert_ne!(hash_of(&run("a"), "mid"), hash_of(&run("b"), "mid"));
        assert_eq!(hash_of(&run("a"), "leaf"), hash_of(&run("b"), "leaf"));
    }

    #[test]
    fn a_child_moved_inside_its_parent_changes_the_hash() {
        // The same bytes around the child, the child in a different spot: not the same markup.
        let hash = |t: &str| {
            let r = Renderer::from_templates(&templates(&[("mid", t), ("leaf", "L")])).unwrap();
            let mut o = String::new();
            r.render_chain_marked(
                &["mid".into(), "leaf".into()],
                &brust_jinja::value_of(&serde_json::json!({})),
                &|_| Overlay::default(),
                &|_| false,
                &mut o,
            )
            .unwrap()
            .unwrap()
        };
        assert_ne!(
            hash("ab{{ __outlet | safe }}cd"),
            hash("abc{{ __outlet | safe }}d")
        );
        // A parent that does not render its child hashes the same whatever the child is.
        assert_eq!(hash("ab"), hash("ab"));
    }

    #[test]
    fn hashing_is_done_before_head_hoist_and_asset_injection() {
        let r = three_levels("");
        let (html, root) = mark(&r, serde_json::json!({"t": "T", "n": 1}));
        let mut doc = html.clone();
        ensure_doctype(&mut doc);
        hoist_head_into(&mut doc);
        inject_css_into(&mut doc, &["client/a-0123456789.css".to_string()]);
        // The injected link sits in the head; the root's mark is the chain output's, untouched by it.
        let (again, root_again) = mark(&r, serde_json::json!({"t": "T", "n": 1}));
        assert_eq!(again, html);
        assert_eq!(root, root_again);
        assert!(doc.contains("data-brust-css"));
    }

    #[test]
    fn a_react_level_and_every_level_below_it_get_no_marker() {
        let r = Renderer::from_templates(&templates(&[
            ("root", "<html><body>{{ __outlet | safe }}</body></html>"),
            ("isl", "<brust-island>{{ __outlet | safe }}</brust-island>"),
            ("leaf", "<p>x</p>"),
        ]))
        .unwrap();
        let chain: Vec<String> = vec!["root".into(), "isl".into(), "leaf".into()];
        let run = |chain: &[String], unmarked: &dyn Fn(&str) -> bool| {
            let mut o = String::new();
            let root = r
                .render_chain_marked(
                    chain,
                    &brust_jinja::value_of(&serde_json::json!({})),
                    &|_| Overlay::default(),
                    unmarked,
                    &mut o,
                )
                .unwrap();
            (o, root)
        };
        let (html, root) = run(&chain, &|id| id == "isl");
        assert!(root.is_some());
        assert_eq!(
            html,
            "<html><body><brust-island><p>x</p></brust-island></body></html>"
        );
        // A react root: no root mark either, so the client swaps the whole body.
        let (html, root) = run(&chain, &|id| id == "root");
        assert_eq!(root, None);
        assert!(!html.contains("brust-l"), "{html}");
        // A bare react island chain is untouched.
        let (html, root) = run(&["isl".to_string()], &|id| id == "isl");
        assert_eq!(
            (html.as_str(), root),
            ("<brust-island></brust-island>", None)
        );
    }

    #[test]
    fn an_id_that_cannot_sit_in_a_comment_gets_no_marker() {
        for bad in ["", "a--b", "a-", "a>b", "a b", "a\"b", "a&b", "ä", "a<b"] {
            assert!(!marker_safe(bad), "{bad:?}");
        }
        for ok in ["appLayout_a1", "routes/[slug]/page", "a-b", "a.b:c"] {
            assert!(marker_safe(ok), "{ok:?}");
        }
        let r = Renderer::from_templates(&templates(&[
            ("root", "<html>{{ __outlet | safe }}</html>"),
            ("a--b", "<i></i>"),
        ]))
        .unwrap();
        let mut o = String::new();
        let root = r
            .render_chain_marked(
                &["root".into(), "a--b".into()],
                &brust_jinja::value_of(&serde_json::json!({})),
                &|_| Overlay::default(),
                &|_| false,
                &mut o,
            )
            .unwrap();
        assert!(root.is_some_and(|r| r.starts_with("root:")));
        assert_eq!(o, "<html><i></i></html>");
    }

    fn nav_manifest() -> Manifest {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../brust-server/tests/fixtures/dist");
        let mut m = crate::manifest::Manifest::load(&dir).unwrap().manifest;
        m.assets.nav = Some("client/nav-0123456789.js".into());
        m.assets.build = Some("b0b1b2b3b4".into());
        m
    }

    #[test]
    fn the_nav_tag_is_on_every_full_document_even_an_all_static_one() {
        let m = nav_manifest();
        let tag = "<script type=\"module\" src=\"/_brust/client/nav-0123456789.js\" data-brust-nav data-brust-build=\"b0b1b2b3b4\" data-brust-root=\"root:0123456789abcdef\"></script>";
        let doc = "<html><head></head><body><p>x</p></body></html>";
        // routes[0] is all-static: no runtime tags, the nav tag still goes in before </body>.
        let mut s = doc.to_string();
        inject_document_assets_with_root_into(
            &mut s,
            &m.routes[0].chain,
            &m,
            None,
            None,
            Some("root:0123456789abcdef"),
        );
        assert_eq!(
            s,
            format!("<html><head></head><body><p>x</p>{tag}</body></html>")
        );
        // A page with a native component: the nav tag is FIRST among the body-end scripts.
        let mut d = doc.to_string();
        inject_document_assets_with_root_into(
            &mut d,
            &m.routes[1].chain,
            &m,
            None,
            Some("<script>P</script>"),
            Some("root:0123456789abcdef"),
        );
        let (nav, prefix, rt) = (
            d.find("data-brust-nav").unwrap(),
            d.find("<script>P</script>").unwrap(),
            d.find(&format!("src=\"/_brust/{}\"></script>", m.assets.runtime))
                .unwrap(),
        );
        assert!(nav < prefix && prefix < rt, "{d}");
        assert_eq!(d.matches("data-brust-nav").count(), 1);
        // No root mark: no data-brust-root.
        let mut n = doc.to_string();
        inject_document_assets_into(&mut n, &m.routes[0].chain, &m, None, None);
        assert!(
            n.contains("data-brust-nav") && !n.contains("data-brust-root"),
            "{n}"
        );
        // A fragment (no </body>) gets none, static or not.
        for chain in [&m.routes[0].chain, &m.routes[1].chain] {
            let mut f = "<p>frag</p>".to_string();
            inject_document_assets_into(&mut f, chain, &m, None, None);
            assert!(!f.contains("data-brust-nav"), "{f}");
        }
        // An older manifest (no assets.nav) emits none.
        let mut old = nav_manifest();
        old.assets.nav = None;
        let mut o = doc.to_string();
        inject_document_assets_into(&mut o, &old.routes[0].chain, &old, None, None);
        assert_eq!(o, doc);
    }
}
