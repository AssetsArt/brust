# Implementation Plan — Sub-project J (minijinja dynamic routes)

**Spec:** `docs/superpowers/specs/2026-05-28-minijinja-dynamic-routes-design.md` (v2.2)
**Branch:** `refactor/cargo-workspace` HEAD `f8a038b` (cleanup landed)
**Date:** 2026-05-29

## Pre-conditions (already shipped)

Per spec S15.1 + S15.2 (Rust + TS deletion), commit `f8a038b` removed:
- `crates/brust/src/compiled_routes/`, `napi_render_compiled`, `static_render` fields, `static_prebuilt_for_path`, A2.3 short-circuit
- `static: true` API, `staticRender` field, A2.x validation tests
- maud dep in brust, jsx-rust-compiler build-dep
- bench artifacts (uncommitted)

**Workspace baseline at f8a038b (re-verified):**
- `cargo test -p brust --lib`: 107 passed
- `bun test runtime/`: 189 pass
- `bun test tests/`: 98 pass
- `cargo build --workspace`: green

## Task ordering rationale

Spec S15.3-S15.8. Each task lands a single commit; every intermediate state is green.

```
T1: jsx-rust-compiler emit maud → jinja
    ↓ (jsx-rust-compiler now emits jinja; brust doesn't consume it yet)
T2: brust adds minijinja + jinja.rs module
    ↓ (jinja.rs unit-tested; not wired to napi yet)
T3: brust napi_render_jinja + native_template routing + boot load
    ↓ (Rust side fully wired; JS not yet calling)
T4: runtime native: true API + worker dispatcher
    ↓ (TS validates + dispatches; build pipeline not yet emitting templates)
T5: build CLI — jsx-rustc spawn pass
    ↓ (build emits .brust/jinja/; example/test fixtures not yet using native: true)
T6: example + E2E test
    ↓ (E2E green end-to-end)
T7: docs
```

## Test gates between tasks

Every task ends with:
```bash
cargo build --workspace
cargo test --workspace --lib
bun test runtime/
bun test tests/
```

All must be green before the next task dispatches.

---

## Task 1 — jsx-rust-compiler emit swap (maud → jinja)

**Spec ref:** S5 + S15.3
**Risk:** medium (rewrite emit; goldens must align)

### Files

**Delete:**
- `crates/jsx-rust-compiler/src/emit.rs`
- `crates/jsx-rust-compiler/src/bin/jsx-bench.rs`
- `crates/jsx-rust-compiler/tests/golden_emit.rs`
- `crates/jsx-rust-compiler/tests/golden_render/` (whole dir)
- `crates/jsx-rust-compiler/fixtures/*.expected.rs` (3 files)
- `crates/jsx-rust-compiler/fixtures/*.expected.html` (3 files)

**Create:**
- `crates/jsx-rust-compiler/src/emit_jinja.rs` (replacement)
- `crates/jsx-rust-compiler/tests/golden_emit_jinja.rs`
- `crates/jsx-rust-compiler/tests/golden_render_jinja/main.rs` (and helpers if needed)
- `crates/jsx-rust-compiler/fixtures/static_hello.expected.jinja`
- `crates/jsx-rust-compiler/fixtures/props_hello.expected.jinja`
- `crates/jsx-rust-compiler/fixtures/list_nav.expected.jinja`
- `crates/jsx-rust-compiler/fixtures/static_hello.expected.html`
- `crates/jsx-rust-compiler/fixtures/props_hello.expected.html`
- `crates/jsx-rust-compiler/fixtures/list_nav.expected.html`

**Modify:**
- `crates/jsx-rust-compiler/Cargo.toml` — drop `maud` (dev-dep + optional dep), drop `bench` feature, drop `jsx-bench` `[[bin]]`, add `minijinja = "2"` to `[dev-dependencies]`
- `crates/jsx-rust-compiler/src/lib.rs` — `-mod emit; +mod emit_jinja;` and `Ok(emit::emit(&ir))` → `Ok(emit_jinja::emit(&ir))`
- `crates/jsx-rust-compiler/src/bin/jsx-rustc.rs` — output extension default from `.rs` to `.jinja` (only change at arg level; otherwise unchanged)
- `crates/jsx-rust-compiler/src/lib.rs` — `ErrorKind::VoidElementHasChildren` MAY drop (jinja accepts void with content — relax check in lower.rs if it errors there)

### IR → jinja emission rules (from S5)

| IR | jinja |
|---|---|
| `Element { tag, attrs, children }` non-void | `<tag attrs>children</tag>` |
| `Element` void (br, hr, img, input, link, meta, area, base, col, embed, source, track, wbr) | `<tag attrs/>` |
| `Text(s)` | HTML-escape `s`, emit literal |
| `Expr(Expr::Field(name))` | `{{ name }}` |
| `Expr(Expr::MemberAccess { root, path })` | `{{ root.p0.p1 }}` |
| `Expr(Expr::MapBinding(name))` | `{{ name }}` |
| `Expr(Expr::MapMember { root, path })` | `{{ root.p0.p1 }}` |
| `Expr(Expr::StaticText(s))` | HTML-escape literal |
| `Expr(Expr::StaticNum(n))` | `{{ n }}` |
| `Map { source, binding, body }` | `{% for binding in source %}body{% endfor %}` — `source` is `root.p0.p1` form |

Attribute values:
| AttrValue | jinja |
|---|---|
| `Empty` | `name` |
| `Static(s)` | `name="<attr-escape s>"` |
| `StaticNum(n)` | `name="n"` |
| `Expr(e)` | `name="{{ <emit_expr> }}"` |

Reuse the IR `Expr` walker shape from `emit.rs`. Attribute renames + whitespace handling unchanged from S5.

### Tests (TDD-first)

**Unit (`emit_jinja.rs #[cfg(test)] mod tests`):**

```rust
#[test]
fn emits_static_element_with_text() {
    // ir = Element("div", [], [Text("Hello")])
    // assert emit == "<div>Hello</div>"
}

#[test]
fn emits_text_expr_as_double_brace() {
    // ir = Element("h1", [], [Expr(Field("title"))])
    // assert emit == "<h1>{{ title }}</h1>"
}

#[test]
fn emits_attr_expr_as_quoted_double_brace() {
    // ir = Element("a", [Attr("href", Expr(MemberAccess { root: "item", path: ["href"] }))], [])
    // assert emit == "<a href=\"{{ item.href }}\"></a>"
}

#[test]
fn emits_map_as_for_loop() {
    // ir = Map { source: Field("items"), binding: "item", body: [Element("li",[],[])] }
    // assert emit == "{% for item in items %}<li></li>{% endfor %}"
}

#[test]
fn emits_void_element_self_closing() {
    // ir = Element("br", [], [])
    // assert emit == "<br/>"
}

#[test]
fn html_escape_in_text() {
    // ir = Element("p", [], [Text("a < b & c > d")])
    // assert emit == "<p>a &lt; b &amp; c &gt; d</p>"
}
```

**Golden — emit (`tests/golden_emit_jinja.rs`):**
For each fixture (`static_hello`, `props_hello`, `list_nav`):
1. Read `fixtures/<name>.tsx`
2. `jsx_rust_compiler::compile()` → output
3. Read `fixtures/<name>.expected.jinja`
4. Assert byte-equal (use `pretty_assertions::assert_eq`)

**Golden — render (`tests/golden_render_jinja/main.rs`):**
For each fixture:
1. Compile to jinja source via `jsx_rust_compiler::compile()`
2. Build minijinja `Environment`, register source
3. Render with known context (hardcoded in the test for each fixture)
4. Compare to `fixtures/<name>.expected.html` byte-equal

### Fixture contents

`static_hello.tsx` (existing — keep verbatim):
```tsx
export default function StaticHello() {
  return (
    <div>
      <h1>Hello from compiled Rust</h1>
      <p>This page is statically generated.</p>
    </div>
  )
}
```
→ `static_hello.expected.jinja`:
```
<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>
```
→ `static_hello.expected.html` (rendered with `{}`):
```
<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>
```

`props_hello.tsx`:
```tsx
export default function PropsHello({ name, count }: { name: string; count: number }) {
  return (
    <div>
      <h1>Hello, {name}</h1>
      <p>Count: {count}</p>
    </div>
  )
}
```
→ `props_hello.expected.jinja`:
```
<div><h1>Hello, {{ name }}</h1><p>Count: {{ count }}</p></div>
```
→ `props_hello.expected.html` (rendered with `{name: "World", count: 7}`):
```
<div><h1>Hello, World</h1><p>Count: 7</p></div>
```

`list_nav.tsx`:
```tsx
export default function ListNav({ items }: { items: { href: string; label: string }[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li><a href={item.href}>{item.label}</a></li>
      ))}
    </ul>
  )
}
```
→ `list_nav.expected.jinja`:
```
<ul>{% for item in items %}<li><a href="{{ item.href }}">{{ item.label }}</a></li>{% endfor %}</ul>
```
→ `list_nav.expected.html`:
```
<ul><li><a href="/a">Alpha</a></li><li><a href="/b">Bravo</a></li></ul>
```

### Commands

```bash
cargo test -p jsx-rust-compiler --lib
cargo test -p jsx-rust-compiler --test golden_emit_jinja
cargo test -p jsx-rust-compiler --test golden_render_jinja
cargo build --workspace
cargo test --workspace --lib
bun test runtime/ && bun test tests/
```

### Acceptance

- All emit_jinja unit tests green (≥6)
- 3 golden_emit_jinja goldens byte-equal
- 3 golden_render_jinja outputs byte-equal
- `cargo build --workspace`: green
- `cargo clippy -p jsx-rust-compiler -- -D warnings`: clean
- No reference to `maud` in `jsx-rust-compiler/Cargo.toml`, source, or tests

### BLOCKED fallback

If lower.rs rejects a fixture with `VoidElementHasChildren` or `FragmentNotSupported`, the fixture is wrong — adjust to a Phase-A1-compatible JSX shape (no fragments, no custom components, no event handlers). If a test fails for a reason other than expected-bytes mismatch, escalate.

If the IR's `Expr::MapMember` variant doesn't exist (variant names may differ in `crates/jsx-rust-compiler/src/ir.rs` from the spec table), inspect the actual enum and adjust the emit rules table. Intent preserved; variant names are an impl detail.

### Commit

```
impl(J/T1): jsx-rust-compiler emit target maud → jinja

Replaces emit.rs with emit_jinja.rs per spec S5. Lowering (parser + IR +
lower) is unchanged — T0-T6 of A1 carry over verbatim, only T7's emit
swaps. Fixtures and goldens rewritten for jinja; minijinja replaces maud
as the dev-dep that drives golden_render.

- src/emit.rs → src/emit_jinja.rs (new emit rules per spec S5)
- tests/golden_emit.rs → tests/golden_emit_jinja.rs
- tests/golden_render/ → tests/golden_render_jinja/
- fixtures/*.expected.{rs,html} → fixtures/*.expected.jinja + new
  .expected.html with minijinja-rendered output
- Cargo.toml: -maud, -bench feature, -jsx-bench bin, +minijinja dev-dep
- src/bin/jsx-bench.rs removed
```

---

## Task 2 — brust adds minijinja + jinja.rs

**Spec ref:** S6 + S15.4 part 1
**Risk:** low (new module, no integration yet)

### Files

**Create:**
- `crates/brust/src/jinja.rs`

**Modify:**
- `crates/brust/Cargo.toml` — add `minijinja = "2"` to `[dependencies]`
- `crates/brust/src/lib.rs` — add `mod jinja;`

### `jinja.rs` skeleton (spec S6)

```rust
use std::path::Path;
use std::sync::OnceLock;

use minijinja::{Environment, UndefinedBehavior};

static ENV: OnceLock<Environment<'static>> = OnceLock::new();

pub fn load_from(dir: &Path) -> Vec<String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    let mut names = Vec::new();

    if dir.exists() && dir.is_dir() {
        let entries = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read .brust/jinja/: {e}"));
        for entry in entries {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jinja") {
                continue;
            }
            let name = path.file_stem()
                .and_then(|s| s.to_str())
                .expect("UTF-8 file stem")
                .to_string();
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let source_static: &'static str = Box::leak(source.into_boxed_str());
            let leaked_name: &'static str = Box::leak(name.clone().into_boxed_str());
            env.add_template(leaked_name, source_static)
                .unwrap_or_else(|e| panic!("add_template {}: {e}", path.display()));
            names.push(name);
        }
    }

    ENV.set(env).expect("jinja env initialized once");
    names
}

pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let env = ENV.get().ok_or(RenderError::NotLoaded)?;
    let tmpl = env.get_template(name).map_err(|_| RenderError::UnknownTemplate(name.to_string()))?;
    let value: serde_json::Value = serde_json::from_slice(data_json)
        .map_err(|e| RenderError::BadJson(e.to_string()))?;
    tmpl.render(value).map_err(|e| RenderError::Render(e.to_string()))
}

pub fn registered_templates() -> Vec<String> {
    ENV.get()
        .map(|env| env.templates().map(|(name, _)| name.to_string()).collect())
        .unwrap_or_default()
}

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("jinja Environment not loaded (call load_from first)")]
    NotLoaded,
    #[error("unknown template: {0:?}")]
    UnknownTemplate(String),
    #[error("bad JSON: {0}")]
    BadJson(String),
    #[error("render: {0}")]
    Render(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("HelloPage.jinja"),
            "<div><h1>Hello, {{ name }}</h1></div>").unwrap();
        std::fs::write(dir.path().join("ListNav.jinja"),
            "<ul>{% for item in items %}<li>{{ item.label }}</li>{% endfor %}</ul>").unwrap();
        dir
    }

    #[test]
    fn jinja_round_trip() {
        // Single test serializing all sub-checks to avoid OnceLock contention.
        let dir = write_fixture_dir();
        let names = load_from(dir.path());
        assert!(names.contains(&"HelloPage".to_string()));
        assert!(names.contains(&"ListNav".to_string()));

        let out = render("HelloPage", br#"{"name":"World"}"#).expect("render");
        assert_eq!(out, "<div><h1>Hello, World</h1></div>");

        let out = render("ListNav", br#"{"items":[{"label":"A"},{"label":"B"}]}"#).expect("render");
        assert_eq!(out, "<ul><li>A</li><li>B</li></ul>");

        match render("NotThere", b"{}") {
            Err(RenderError::UnknownTemplate(name)) => assert_eq!(name, "NotThere"),
            other => panic!("expected UnknownTemplate, got {other:?}"),
        }

        match render("HelloPage", b"not json") {
            Err(RenderError::BadJson(_)) => (),
            other => panic!("expected BadJson, got {other:?}"),
        }

        let templates = registered_templates();
        assert!(templates.contains(&"HelloPage".to_string()));
        assert!(templates.contains(&"ListNav".to_string()));
    }
}
```

**Note on OnceLock testability:** `static ENV: OnceLock<Environment>` means `ENV.set()` panics on second call. Unit tests run in the same process; the only clean shape is a single `#[test]` that exercises all paths. The lenient-missing-dir case is covered structurally (the if-branch) + by the E2E test in Task 6.

Add `tempfile = "3"` to `[dev-dependencies]` in `crates/brust/Cargo.toml` if not present.

### Commands

```bash
cargo build -p brust 2>&1 | tail
cargo test -p brust --lib jinja 2>&1 | tail
cargo clippy -p brust --lib -- -D warnings
```

### Acceptance

- `cargo build -p brust`: green
- `cargo test -p brust --lib jinja::tests::jinja_round_trip`: passes
- `cargo clippy`: clean
- `crates/brust/src/jinja.rs` exists; `mod jinja;` in lib.rs

### BLOCKED fallback

If minijinja's `Environment::templates()` API doesn't return `impl Iterator<Item=(&str, &Template)>`, check actual API and adapt `registered_templates()`. The intent is "list registered template names".

`Box::leak` for source + name is intentional per spec S6 (OnceLock + 'static templates). RwLock + hot reload deferred to v2.x.

### Commit

```
impl(J/T2): brust adds minijinja + jinja.rs

Spec S6 + S15.4 part 1. New module `crates/brust/src/jinja.rs`:
- OnceLock<Environment<'static>> (hot reload deferred per S13.7)
- UndefinedBehavior::Chainable (reviewer OQ 4)
- load_from lenient on missing dir (reviewer Fix 1)
- render(name, &data_json_bytes) -> Result<String, RenderError>
- registered_templates() for boot-time validation

Unit tests in jinja.rs #[cfg(test)] cover load + render hit + render
unknown + bad JSON + registered list. OnceLock means tests share state;
suite uses one consolidated test.
```

---

## Task 3 — brust `napi_render_jinja` + `native_template` routing + boot load

**Spec ref:** S3 + S6 (napi shim) + S8 + S15.4 part 2
**Risk:** HIGH — SAB framing claim is the load-bearing reviewer fix.

### Files

**Modify:**
- `crates/brust/src/routes.rs` — add `RouteConfig.native_template`, `RouteTable.native_templates`, `native_template_for(route_id)`, add `native_template` to `RouteEnvelope` JSON output
- `crates/brust/src/lib.rs` — add `napi_render_jinja`, `napi_list_native_templates`, `napi_load_jinja_templates(dir)`

### `routes.rs` additions

```rust
#[derive(Debug, Deserialize)]
pub struct RouteConfig {
    pub path: String,
    #[serde(default)]
    pub cache: Option<CacheConfig>,
    /// Sub-project J — JS-side ships `nativeTemplate: Component.name` when
    /// the route has `native: true`. Rust uses this name to dispatch via
    /// minijinja instead of React.
    #[serde(default, rename = "nativeTemplate")]
    pub native_template: Option<String>,
}

#[derive(Default)]
pub struct RouteTable {
    inner: RwLock<matchit::Router<u32>>,
    cache_configs: RwLock<Vec<Option<CacheConfig>>>,
    native_templates: RwLock<Vec<Option<String>>>,
}

impl RouteTable {
    pub fn install_with_config(&self, configs: &[RouteConfig]) -> Result<u32, RouteInstallError> {
        let mut router = matchit::Router::new();
        let mut caches: Vec<Option<CacheConfig>> = Vec::with_capacity(configs.len());
        let mut natives: Vec<Option<String>> = Vec::with_capacity(configs.len());
        for (idx, c) in configs.iter().enumerate() {
            router.insert(c.path.clone(), idx as u32).map_err(|e| RouteInstallError::Insert {
                pattern: c.path.clone(),
                reason: e.to_string(),
            })?;
            caches.push(c.cache.clone());
            natives.push(c.native_template.clone());
        }
        *self.inner.write() = router;
        *self.cache_configs.write() = caches;
        *self.native_templates.write() = natives;
        Ok(configs.len() as u32)
    }

    pub fn native_template_for(&self, route_id: u32) -> Option<String> {
        self.native_templates.read().get(route_id as usize).and_then(|n| n.clone())
    }

    pub fn match_path(&self, method: &str, full_path: &str, raw_request: &[u8]) -> MatchResult {
        let (path_only, query) = match full_path.split_once('?') {
            Some((p, q)) => (p, q),
            None => (full_path, ""),
        };
        let router = self.inner.read();
        match router.at(path_only) {
            Ok(matched) => {
                let route_id = *matched.value;
                let mut params: HashMap<&str, &str> = HashMap::new();
                for (k, v) in matched.params.iter() {
                    params.insert(k, v);
                }
                let req = build_request_envelope(method, full_path, query, raw_request);
                let native = self.native_templates.read().get(route_id as usize).and_then(|n| n.clone());
                let envelope = RouteEnvelope {
                    kind: "render",
                    route_id,
                    path: full_path,
                    params,
                    req,
                    native_template: native.as_deref(),
                };
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                MatchResult::Matched { route_id, envelope_json }
            }
            Err(_) => MatchResult::NoMatch,
        }
    }
}
```

**`RouteEnvelope` struct update:**

```rust
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub kind: &'static str,
    pub route_id: u32,
    pub path: &'a str,
    pub params: HashMap<&'a str, &'a str>,
    pub req: RequestEnvelope,
    #[serde(skip_serializing_if = "Option::is_none", rename = "nativeTemplate")]
    pub native_template: Option<&'a str>,
}
```

**Update existing test** in routes.rs (`render_envelope_has_kind_discriminant`): add `native_template: None` to `RouteConfig` initializer.

### `lib.rs` — napi shims (mirror napi_render_chunk_final at lib.rs:570)

```rust
/// Sub-project J — render via minijinja using SAB-side-channeled loader data.
///
/// SAB convention: INBOUND. JS has written `data_len` bytes of raw JSON to
/// SAB[0..data_len]. Rust deserializes, renders the named template, then
/// assembles the `[meta_len: u16 BE][meta JSON][body]` shape that per-conn
/// task at server.rs:1101 unconditionally calls split_meta() on — see
/// render_stream.rs:33-45. Ships via RenderChunk::BytesAndFinal on the
/// same chunk_tx as napi_render_chunk_final.
#[napi]
pub async fn napi_render_jinja(
    worker_id: u32,
    data_len: u32,
    template_name: String,
) -> NapiResult<()> {
    let entry = state()
        .pool
        .entry(worker_id)
        .ok_or_else(|| napi::Error::from_reason(format!("worker {} not registered", worker_id)))?;

    if data_len as usize > entry.buf_len {
        return Err(napi::Error::from_reason(format!(
            "data_len {} exceeds SAB len {}", data_len, entry.buf_len
        )));
    }

    let chunk_tx = entry.render_slot
        .lock()
        .as_ref()
        .map(|s| s.chunk_tx.clone())
        .ok_or_else(|| napi::Error::from_reason("no active render slot"))?;

    // SAFETY: BufPtr pinned at register time; data_len bounds-checked above.
    let data_json = unsafe { std::slice::from_raw_parts(entry.buf_ptr.0, data_len as usize) };

    let (meta_json, body): (Vec<u8>, Vec<u8>) = match crate::jinja::render(&template_name, data_json) {
        Ok(html) => {
            let meta = serde_json::json!({
                "status": 200,
                "contentType": "text/html; charset=utf-8",
                "headers": {},
                "streaming": false,
            });
            (serde_json::to_vec(&meta).expect("meta serialize"), html.into_bytes())
        }
        Err(e) => {
            tracing::error!("jinja render failed for template {:?}: {}", template_name, e);
            let meta = serde_json::json!({
                "status": 500,
                "contentType": "text/plain; charset=utf-8",
                "headers": {},
                "streaming": false,
            });
            (serde_json::to_vec(&meta).expect("meta serialize"), b"internal error".to_vec())
        }
    };

    if meta_json.len() > u16::MAX as usize {
        return Err(napi::Error::from_reason("meta JSON exceeds u16::MAX"));
    }
    let meta_len = meta_json.len() as u16;
    let total = 2 + meta_json.len() + body.len();
    let mut assembled = Vec::with_capacity(total);
    assembled.extend_from_slice(&meta_len.to_be_bytes());
    assembled.extend_from_slice(&meta_json);
    assembled.extend_from_slice(&body);

    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    chunk_tx
        .send(crate::pool::RenderChunk::BytesAndFinal { data: assembled, ack: ack_tx })
        .await
        .map_err(|_| napi::Error::from_reason("render chunk channel closed"))?;
    ack_rx.await.map_err(|_| napi::Error::from_reason("ack dropped"))?;
    Ok(())
}

#[napi]
pub fn napi_list_native_templates() -> Vec<String> {
    crate::jinja::registered_templates()
}

#[napi]
pub fn napi_load_jinja_templates(dir: String) -> Vec<String> {
    crate::jinja::load_from(std::path::Path::new(&dir))
}
```

### Tests (routes.rs)

```rust
#[test]
fn route_table_natives_indexed_by_route_id() {
    let table = RouteTable::new();
    let cfgs = vec![
        RouteConfig { path: "/a".into(), cache: None, native_template: None },
        RouteConfig { path: "/b".into(), cache: None, native_template: Some("Profile".into()) },
        RouteConfig { path: "/c".into(), cache: None, native_template: None },
    ];
    table.install_with_config(&cfgs).unwrap();
    assert_eq!(table.native_template_for(0), None);
    assert_eq!(table.native_template_for(1), Some("Profile".to_string()));
    assert_eq!(table.native_template_for(2), None);
}

#[test]
fn envelope_includes_native_template_when_set() {
    let table = RouteTable::new();
    let cfgs = vec![
        RouteConfig { path: "/x".into(), cache: None, native_template: Some("MyPage".into()) },
    ];
    table.install_with_config(&cfgs).unwrap();
    let raw = b"GET /x HTTP/1.1\r\nHost: x\r\n\r\n";
    let result = table.match_path("GET", "/x", raw);
    match result {
        MatchResult::Matched { envelope_json, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
            assert_eq!(parsed["nativeTemplate"], "MyPage");
        }
        _ => panic!("expected match"),
    }
}

#[test]
fn envelope_omits_native_template_when_unset() {
    let table = RouteTable::new();
    let cfgs = vec![
        RouteConfig { path: "/y".into(), cache: None, native_template: None },
    ];
    table.install_with_config(&cfgs).unwrap();
    let raw = b"GET /y HTTP/1.1\r\nHost: x\r\n\r\n";
    let result = table.match_path("GET", "/y", raw);
    match result {
        MatchResult::Matched { envelope_json, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
            assert!(parsed.get("nativeTemplate").is_none());
        }
        _ => panic!("expected match"),
    }
}
```

### Commands

```bash
cargo build -p brust 2>&1 | tail
cargo test -p brust --lib 2>&1 | tail
bun run build 2>&1 | tail   # regenerates index.d.ts with new napi functions
cargo clippy -p brust --lib -- -D warnings
```

### Acceptance

- `cargo build --workspace`: green
- All existing brust unit tests pass
- New route_table tests pass
- `bun run build` regenerates the cdylib with `napiRenderJinja`, `napiListNativeTemplates`, `napiLoadJinjaTemplates` exported
- `cargo clippy`: clean

### BLOCKED fallback

If `BufPtr` field or `render_slot` access pattern differs from `napi_render_chunk_final` (lib.rs:570-590), mirror that exact function — it's the canonical pattern.

If `tracing::error!` isn't usable (it IS a dep — `tracing = "0.1"`), fall back to `eprintln!`.

If per-conn task at `server.rs:1101` doesn't call `split_meta` on the data (handoff S"Critical implementation details" pillar 1 — VERIFY THIS), STOP and call advisor. The whole SAB framing claim depends on this.

### Commit

```
impl(J/T3): brust napi_render_jinja + native_template routing

Spec S6 (napi shim) + S8 + S15.4 part 2. Rust side fully wired; JS lands T4.

- routes.rs: RouteConfig.native_template, RouteTable.native_templates,
  native_template_for() getter, RouteEnvelope.nativeTemplate field
  (serde rename, skip when None)
- lib.rs: napi_render_jinja(worker_id, data_len, template_name) — reads
  SAB as inbound JSON, renders via crate::jinja::render(), assembles
  [meta_len][meta JSON][body] shape that split_meta() expects, ships via
  RenderChunk::BytesAndFinal on the same chunk_tx as napi_render_chunk_final
- napi_list_native_templates() + napi_load_jinja_templates(dir) shims

SAB convention is per-napi-call (spec S6 last paragraph):
  napi_render_jinja: SAB[0..data_len] = inbound JSON data
  napi_render_chunk_final: SAB[0..len] = outbound chunk (existing)
```

---

## Task 4 — runtime `native: true` API + worker dispatcher

**Spec ref:** S4 + S9 + S15.5
**Risk:** medium (TS validation + worker render branch)

### Files

**Modify:**
- `runtime/routes.ts` — add `native?: boolean` to `Route`, add `nativeTemplate?: string` to `FlatRoute`, add validation block, update `makeFlat`, insert worker-side jinja branch before the React render
- `runtime/routes.test.ts` — 8 validation tests
- `runtime/index.ts` — `registerRoutes` payload gains `nativeTemplate: r.nativeTemplate ?? null`; add boot-time `napiListNativeTemplates` warning + `napiLoadJinjaTemplates` call
- `runtime/index.d.ts` — auto-regen via `bun run build` (do NOT hand-edit)

### `runtime/routes.ts` `Route` interface

```ts
interface Route {
  // ... existing fields
  /** Sub-project J — render this route via the native (jinja) engine, not React.
   * `Component` is REQUIRED (the JSX file is the source jsx-rustc compiles
   * into `.brust/jinja/<Component.name>.jinja`). Loader-friendly: the loader's
   * return value becomes the template context. */
  native?: boolean
}
```

`FlatRoute`:
```ts
export interface FlatRoute {
  fullPath: string
  chain: Route[]
  middleware: Middleware[]
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  cache?: RouteCacheConfig
  /** Sub-project J — Component.name when leaf had `native: true`. Captured
   * at flatten time (build-time AST identifier), so minifier-safe. */
  nativeTemplate?: string
}
```

### `validateRoute` block (place BEFORE the existing `r.sse` check)

```ts
if (r.native === true) {
  const where = r.path ?? '(no path)'
  if (r.Component === undefined) {
    throw new Error(`Route ${where}: 'native: true' requires 'Component'`)
  }
  if (!r.Component.name || r.Component.name.length === 0) {
    throw new Error(`Route ${where}: 'native: true' Component must be a named function (got anonymous)`)
  }
  if (r.sse !== undefined) {
    throw new Error(`Route ${where}: 'native: true' cannot coexist with 'sse'`)
  }
  if (r.websocket !== undefined) {
    throw new Error(`Route ${where}: 'native: true' cannot coexist with 'websocket'`)
  }
  if (r.children !== undefined) {
    throw new Error(`Route ${where}: 'native: true' cannot have nested children`)
  }
  if (r.cache !== undefined) {
    throw new Error(`Route ${where}: 'native: true' cannot coexist with 'cache' (deferred)`)
  }
  // loader + middleware are EXPLICITLY allowed.
}
```

### `makeFlat` update

```ts
const leaf = chain[chain.length - 1]
const cache = leaf.cache
const nativeTemplate = leaf.native === true && leaf.Component
  ? leaf.Component.name
  : undefined
return { fullPath, chain, middleware, errorBoundary, cache, nativeTemplate }
```

### Worker render dispatcher branch (in routes.ts where `call.kind === 'render'`)

Insert BEFORE the React `buildRenderElement(...)` call:

```ts
// NEW: native: true branch
if (flat?.nativeTemplate !== undefined) {
  let data: unknown = {}
  const leaf = flat.chain[flat.chain.length - 1]
  if (leaf.loader) {
    const ctx = { params: call.params, path: call.path, req: call.req }
    try {
      data = await leaf.loader(ctx as any)
    } catch (err) {
      console.error(`[brust] loader failed for native route ${flat.fullPath}:`, err)
      await emitSingleChunkResponse(view, napi, workerId, encoder, {
        status: 500, contentType: 'text/html; charset=utf-8', body: 'internal error',
      })
      return
    }
  }
  const json = JSON.stringify(data ?? {})
  const dataBytes = encoder.encode(json)
  if (dataBytes.length > view.length) {
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 413, contentType: 'text/plain; charset=utf-8',
      body: 'loader data too large for SAB',
    })
    return
  }
  view.set(dataBytes, 0)
  try {
    await (native as any).napiRenderJinja(Number(workerId), dataBytes.length, flat.nativeTemplate)
  } catch (err) {
    console.error(`[brust] napiRenderJinja failed for "${flat.nativeTemplate}":`, err)
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 500, contentType: 'text/html; charset=utf-8', body: 'internal error',
    })
  }
  return
}

// React path (unchanged)
```

### `runtime/index.ts` updates

Replace existing `registerRoutes`:

```ts
registerRoutes(routes: import('./routes.ts').FlatRoute[]): number {
  const configs = routes.map((r) => JSON.stringify({
    path: r.fullPath,
    cache: r.cache ?? null,
    nativeTemplate: r.nativeTemplate ?? null,
  }))
  const result = (native as any).registerRoutes(configs)

  // Reviewer Fix 1 — startup validation. Every native: true route's
  // Component.name must have a registered .jinja template, else 500
  // at request time. Warn here.
  const expected = routes.filter(r => r.nativeTemplate).map(r => r.nativeTemplate!)
  if (expected.length > 0) {
    const registered = new Set<string>((native as any).napiListNativeTemplates() ?? [])
    for (const name of expected) {
      if (!registered.has(name)) {
        console.warn(`[brust] native: true route expects template "${name}.jinja" but it's not registered (boot warning — request will 500)`)
      }
    }
  }
  return result
}
```

Add jinja template load on boot. The cleanest hook is in the brust main process initialization. Look at `runtime/index.ts` for the `serve()` or `run()` entry; add this BEFORE `registerRoutes`:

```ts
import * as path from 'node:path'

// Add to the serve() or run() entry path, right after the cdylib loads:
const jinjaDir = path.resolve(process.cwd(), '.brust/jinja')
;(native as any).napiLoadJinjaTemplates(jinjaDir)
```

Idempotent on second-run-attempt because `OnceLock` panics on second `set()`, so guard:
```ts
let _jinjaLoaded = false
function loadJinjaOnce(dir: string) {
  if (_jinjaLoaded) return
  ;(native as any).napiLoadJinjaTemplates(dir)
  _jinjaLoaded = true
}
```

### `runtime/routes.test.ts` validation block

```ts
// ----- Sub-project J `native: true` validation tests -----

function NamedPage() { return null }

test('flattenRoutes accepts native: true + Component (NamedPage)', () => {
  const flat = flattenRoutes([
    { path: '/', Component: NamedPage, native: true },
  ] as Route[])
  expect(flat.length).toBe(1)
  expect(flat[0]!.nativeTemplate).toBe('NamedPage')
})

test('flattenRoutes accepts native: true + Component + loader', () => {
  const flat = flattenRoutes([
    { path: '/', Component: NamedPage, native: true, loader: async () => ({ x: 1 }) },
  ] as Route[])
  expect(flat[0]!.nativeTemplate).toBe('NamedPage')
})

test('flattenRoutes accepts native: true + middleware', () => {
  const flat = flattenRoutes([
    { path: '/', Component: NamedPage, native: true, middleware: [async (_, next) => next()] },
  ] as Route[])
  expect(flat[0]!.nativeTemplate).toBe('NamedPage')
})

test('flattenRoutes rejects native: true without Component', () => {
  expect(() => flattenRoutes([{ path: '/x', native: true } as Route])).toThrow(/'native: true' requires 'Component'/)
})

test('flattenRoutes rejects native: true with anonymous Component', () => {
  const anon = (function () { return (function () { return null }) })() as unknown
  expect(() => flattenRoutes([{ path: '/x', Component: anon as never, native: true } as Route])).toThrow(/must be a named function/)
})

test('flattenRoutes rejects native: true + sse', () => {
  expect(() => flattenRoutes([
    { path: '/x', Component: NamedPage, native: true, sse: () => new ReadableStream() } as Route,
  ])).toThrow(/cannot coexist with 'sse'/)
})

test('flattenRoutes rejects native: true + children', () => {
  expect(() => flattenRoutes([
    { path: '/x', Component: NamedPage, native: true, children: [{ path: 'y', Component: NamedPage }] } as Route,
  ])).toThrow(/nested children/)
})

test('flattenRoutes rejects native: true + cache (deferred)', () => {
  expect(() => flattenRoutes([
    { path: '/x', Component: NamedPage, native: true, cache: { ttl_seconds: 60 } } as Route,
  ])).toThrow(/cannot coexist with 'cache'/)
})
```

### Commands

```bash
bun run build 2>&1 | tail   # regen index.d.ts
bun test runtime/ 2>&1 | tail
```

### Acceptance

- `bun test runtime/routes.test.ts`: 8 new tests pass
- `bun test runtime/`: total ≥197 pass
- `runtime/index.d.ts` regenerated with new napi fn declarations
- All existing runtime tests still pass

### BLOCKED fallback

If the worker render dispatcher's structure differs from spec S9 (e.g. `call.kind === 'render'` branch is somewhere unexpected), trace the actual flow in `runtime/routes.ts` `makeRenderer` and adapt — goal is "branch on `flat.nativeTemplate` before the React render call".

If `napiLoadJinjaTemplates` returns `null` instead of `[]` for missing dir, handle both with `?? []`.

### Commit

```
impl(J/T4): runtime native: true API + worker dispatcher branch

Spec S4 + S9 + S15.5.

- Route.native?: boolean
- FlatRoute.nativeTemplate?: string (Component.name when leaf had native: true)
- validateRoute: requires Component + non-empty name; rejects sse/ws/
  children/cache; ALLOWS loader + middleware
- Worker dispatcher: native: true branch runs loader → JSON.stringify →
  SAB write → napiRenderJinja(workerId, dataLen, templateName). On
  napi throw: emit 500 chunk. SAB cap exceeded: 413.
- registerRoutes payload: nativeTemplate field. Boot-time warning when
  expected template not in napiListNativeTemplates() (reviewer Fix 1).
- 8 validation tests in routes.test.ts.
```

---

## Task 5 — build CLI: jsx-rustc spawn pass

**Spec ref:** S7 + S15.6
**Risk:** medium

### Files

**Create:**
- `runtime/cli/native-routes-emit.ts` — pure helper

**Modify:**
- `runtime/cli/build.ts` — invoke `emitNativeTemplates` after flat routes computed
- `runtime/cli/dev.ts` — same (one-time at boot; HMR deferred)
- `.gitignore` — append `.brust/jinja/`

### Algorithm

```ts
// runtime/cli/native-routes-emit.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface NativeRouteEmitOpts {
  entryFile: string             // user's routes entry (absolute path)
  flatRoutes: { nativeTemplate?: string }[]
  outDir: string                // .brust/jinja absolute path
  repoRoot: string              // for resolving jsx-rustc binary
}

export async function emitNativeTemplates(opts: NativeRouteEmitOpts): Promise<void> {
  mkdirSync(opts.outDir, { recursive: true })

  const importMap = scanImports(opts.entryFile)
  const nativeRoutes = opts.flatRoutes.filter(r => r.nativeTemplate)

  // Resolve jsx-rustc binary: prefer release, fall back to debug, fall back to cargo run.
  const jsxRustcRelease = resolve(opts.repoRoot, 'target/release/jsx-rustc')
  const jsxRustcDebug = resolve(opts.repoRoot, 'target/debug/jsx-rustc')
  const jsxRustc = existsSync(jsxRustcRelease) ? jsxRustcRelease
                  : existsSync(jsxRustcDebug) ? jsxRustcDebug
                  : null
  if (!jsxRustc && nativeRoutes.length > 0) {
    throw new Error('jsx-rustc binary not found in target/{release,debug}/; run `cargo build -p jsx-rust-compiler`')
  }

  const built: string[] = []
  for (const r of nativeRoutes) {
    const name = r.nativeTemplate!
    const sourcePath = importMap.get(name)
    if (!sourcePath) {
      console.warn(`[brust build] no import for native route "${name}" in ${opts.entryFile}; skipping`)
      continue
    }
    const outPath = resolve(opts.outDir, `${name}.jinja`)
    const result = Bun.spawnSync({
      cmd: [jsxRustc!, sourcePath, '-o', outPath],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ''
      throw new Error(`jsx-rustc failed for ${sourcePath}: ${stderr}`)
    }
    built.push(name)
  }

  writeFileSync(
    resolve(opts.outDir, '_manifest.json'),
    JSON.stringify({ templates: built, generatedAt: new Date().toISOString() }, null, 2),
  )
}

function scanImports(entryFile: string): Map<string, string> {
  const source = readFileSync(entryFile, 'utf8')
  const map = new Map<string, string>()
  // Regex-based scanner — handles: `import Name from './path'`
  // Full swc AST scan deferred to v2.x per spec S7 + S13.10.
  const re = /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const localName = m[1]!
    const importPath = m[2]!
    if (!importPath.startsWith('.')) continue   // skip package imports
    const baseDir = dirname(entryFile)
    const resolved = resolve(baseDir, importPath)
    // Try extensions: .tsx, .ts, /index.tsx, /index.ts
    const candidates = [
      `${resolved}.tsx`, `${resolved}.ts`,
      `${resolved}/index.tsx`, `${resolved}/index.ts`,
    ]
    const found = candidates.find(p => existsSync(p))
    if (found) map.set(localName, found)
  }
  return map
}
```

**Integration in `build.ts`:**

Find where `brust build` resolves the user's entry file + loads routes. After route module loads + `flat` is computed, add:

```ts
import { emitNativeTemplates } from './native-routes-emit.ts'

// Existing: load user's routes module, get `flat = flattenRoutes(userRoutes)`.

// NEW: emit jinja templates.
await emitNativeTemplates({
  entryFile: entryPath,
  flatRoutes: flat,
  outDir: resolve(cwd, '.brust/jinja'),
  repoRoot: REPO_ROOT,
})
```

**Integration in `dev.ts`:**

Same call. HMR-on-edit deferred per spec S12 hot-reload bullet — boot-time only is acceptable for v2.

### `.gitignore`

Append (find existing `.brust/css/` line first):
```
.brust/jinja/
```

### Tests (manual smoke)

```bash
cd example/hello-world
bun run build       # should produce .brust/jinja/ even if no native routes
ls -la .brust/jinja/
cat .brust/jinja/_manifest.json
```

Example has no native routes yet (Task 6 adds them), so manifest will list `templates: []`. Verifies the pipeline runs without errors.

### Commands

```bash
cargo build -p jsx-rust-compiler --bin jsx-rustc   # ensure binary exists in target/
cd example/hello-world
bun run build 2>&1 | tail
cat .brust/jinja/_manifest.json
cd ../..
bun test runtime/
```

### Acceptance

- `bun run build` in `example/hello-world` succeeds
- `.brust/jinja/_manifest.json` written (templates: [] for now)
- `.gitignore` has `.brust/jinja/`
- `bun test runtime/` still green

### BLOCKED fallback

If `jsx-rustc` binary path varies in CI (custom target dir), check env `CARGO_TARGET_DIR` first.

If `Bun.spawnSync` isn't the brust convention (search for existing spawn calls in cli/), match what's used elsewhere.

If dev.ts watcher integration is complex, ship one-time-at-boot call + add a TODO for v2.x HMR.

### Commit

```
impl(J/T5): build CLI emits .brust/jinja/ templates

Spec S7 + S15.6. New pass scans user's routes entry for
ImportDeclarations, resolves each native: true route's Component to
its .tsx source, invokes jsx-rustc to emit .brust/jinja/<Name>.jinja,
writes _manifest.json.

- runtime/cli/native-routes-emit.ts: helper (regex import scanner +
  jsx-rustc invoke + manifest write)
- build.ts + dev.ts: invoke after flattenRoutes
- .gitignore: .brust/jinja/

Limitations (per spec S7 + S13.10):
- Regex scanner handles `import Name from './path'` only; full swc AST
  + re-export chain support deferred to v2.x
- Dev mode does NOT hot-reload templates on .tsx edit (boot-only;
  restart required) — deferred per S12
```

---

## Task 6 — example + E2E test

**Spec ref:** S10 + S15.7
**Risk:** medium (end-to-end integration)

### Files

**Modify:**
- `example/hello-world/routes.tsx` — add a `native: true` route
- `tests/fixtures/app/routes.tsx` — add a `native: true` route used by E2E

**Create:**
- `example/hello-world/pages/NativeProfile.tsx`
- `tests/jinja-route.test.ts`

### Example route

`example/hello-world/pages/NativeProfile.tsx`:
```tsx
export default function NativeProfile({ user, greeting }: { user: string; greeting: string }) {
  return (
    <div>
      <h1>{greeting}</h1>
      <p>User: {user}</p>
    </div>
  )
}
```

Add to `example/hello-world/routes.tsx` route array:
```tsx
import NativeProfile from './pages/NativeProfile'

// ...
{
  path: '/native-profile/{user}',
  Component: NativeProfile,
  native: true,
  loader: async ({ params }) => ({
    user: params.user,
    greeting: `Welcome, ${params.user}`,
  }),
},
```

### Test fixture route

In `tests/fixtures/app/routes.tsx`:
```tsx
import NativeProfile from '../../../example/hello-world/pages/NativeProfile'

// ...
{
  path: '/_test/native/{user}',
  Component: NativeProfile,
  native: true,
  loader: async ({ params }) => ({
    user: params.user,
    greeting: `Hello, ${params.user}`,
  }),
},
```

### `tests/jinja-route.test.ts`

Match the shape of `tests/integration.test.ts` (it already spawns brust against `tests/fixtures/app` and curls). Reuse the spawn helper / port pattern.

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/app')
const BASE_URL = 'http://127.0.0.1:3801'

let proc: ReturnType<typeof Bun.spawn> | undefined

async function waitForReady(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/ping`)
      if (res.status === 200) return
    } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server didn't become ready at ${url}`)
}

beforeAll(async () => {
  // Pre-flight: ensure jsx-rustc binary exists.
  const repoRoot = resolve(import.meta.dir, '..')
  const buildRustc = Bun.spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: repoRoot,
    stdout: 'inherit', stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) throw new Error('cargo build jsx-rustc failed')

  // Build the fixture app — emits .brust/jinja/NativeProfile.jinja
  const buildRes = Bun.spawnSync({
    cmd: ['bun', 'run', resolve(repoRoot, 'runtime/cli/build.ts'), 'index.ts'],
    cwd: FIXTURE_DIR,
    stdout: 'pipe', stderr: 'pipe',
  })
  if (buildRes.exitCode !== 0) {
    console.error(new TextDecoder().decode(buildRes.stdout))
    console.error(new TextDecoder().decode(buildRes.stderr))
    throw new Error(`build failed (exit ${buildRes.exitCode})`)
  }
  expect(existsSync(resolve(FIXTURE_DIR, '.brust/jinja/NativeProfile.jinja'))).toBe(true)

  // Spawn brust against the built app.
  proc = Bun.spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: { ...process.env, BRUST_PORT: '3801' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await waitForReady(BASE_URL)
})

afterAll(() => {
  proc?.kill('SIGTERM')
})

test('GET /_test/native/Alice → minijinja-rendered HTML with loader data', async () => {
  const res = await fetch(`${BASE_URL}/_test/native/Alice`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const body = await res.text()
  expect(body).toContain('<h1>Hello, Alice</h1>')
  expect(body).toContain('<p>User: Alice</p>')
})

test('GET /_test/native/Bob → different param renders correctly', async () => {
  const res = await fetch(`${BASE_URL}/_test/native/Bob`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<h1>Hello, Bob</h1>')
  expect(body).toContain('<p>User: Bob</p>')
})

test('GET /unknown returns 404 (regression — react path unaffected)', async () => {
  const res = await fetch(`${BASE_URL}/this-does-not-exist`)
  expect(res.status).toBe(404)
})

test('GET / (HelloWorld React route) still works', async () => {
  const res = await fetch(`${BASE_URL}/`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body.length).toBeGreaterThan(0)
})
```

**Reuse existing fixtures**: the fixture's `index.ts`, port handling, and route setup already work for `tests/integration.test.ts`. Look at that test for the exact pattern.

### Commands

```bash
cargo build -p jsx-rust-compiler --bin jsx-rustc
bun run build                       # cdylib + .brust/jinja for example/
bun test tests/jinja-route.test.ts 2>&1 | tail
bun test runtime/ && bun test tests/
```

### Acceptance

- `tests/jinja-route.test.ts`: all 4 tests pass
- `tests/integration.test.ts -t 'serves rendered html'`: still passes (React unaffected)
- Total `bun test tests/`: ≥98 + 4 = ≥102
- `.brust/jinja/NativeProfile.jinja` exists after build

### BLOCKED fallback

If `tests/fixtures/app/index.ts` doesn't exist or has a different shape, look at how `tests/integration.test.ts` spawns brust against the fixture; match that shape.

If brust spawn fails because the fixture app expects a specific port via env var different from `BRUST_PORT`, check existing integration test for the right env var.

If `napiLoadJinjaTemplates` never gets called during boot (Task 4's load hook didn't land where expected), call it explicitly in the test's `beforeAll` via direct napi import. Idempotent (OnceLock), so safe.

If the E2E hangs (per-conn task waiting on something), STOP and call advisor. SAB framing is the prime suspect.

### Commit

```
impl(J/T6): example + E2E test for native: true routes

Spec S10 + S15.7.

- example/hello-world/pages/NativeProfile.tsx + /native-profile/{user}
  route (native: true with real loader)
- tests/fixtures/app: same route at /_test/native/{user}
- tests/jinja-route.test.ts: 4 tests covering happy path (2 different
  param values), 404 regression, and React path unchanged
```

---

## Task 7 — docs (architecture.md rewrite)

**Spec ref:** S15.8
**Risk:** low (docs only)

### Files

**Modify:**
- `architecture.md` — Sub-project A1+A1.1 section rewritten as Sub-project J; remove dangling `napi_render_compiled` reference; update "Suggested next steps"

### Tasks

1. Grep architecture.md for `napi_render_compiled`, `static_render`, `static: true`, `compiled_routes`, `Sub-project A1`, `Sub-project A2` — replace with Sub-project J references where applicable
2. Add a Sub-project J section describing minijinja architecture (per spec S3)
3. Update "Suggested next steps" with v2.x deferrals (cache integration, nested loader composition, hot reload, dev-mode React fallback)

### Acceptance

Spec S11 criterion 9 — zero hits across `.rs/.ts/.tsx/.toml/.md`:
```bash
grep -rn -E 'maud|static: true|staticRender|rustCompiled|napi_render_compiled|compiled_routes|jinja: true|jinja\?:|jinjaTemplate' \
  --include='*.rs' --include='*.ts' --include='*.tsx' --include='*.toml' --include='*.md' .
# returns empty
```

### Commit

```
impl(J/T7): docs — architecture.md rewrites A1+A1.1 → Sub-project J

Spec S15.8.

- Removed Sub-project A1 + A1.1 sections (maud-emit chain retired;
  jsx-rust-compiler keeps parser + IR + lower per S15.3)
- Added Sub-project J section describing the minijinja architecture
- Removed dangling napi_render_compiled reference
- Updated Suggested next steps with v2.x deferrals

Acceptance grep S11.9 zero-hits across .rs/.ts/.tsx/.toml/.md.
```

---

## Final acceptance check (spec S11)

After T7 commits, the orchestrator runs:

```bash
cargo build --workspace
cargo test --workspace --lib
bun run build
bun test runtime/
bun test tests/
cargo clippy --workspace -- -D warnings

# Zero-hits grep (criterion 9)
grep -rn -E 'maud|static: true|staticRender|rustCompiled|napi_render_compiled|compiled_routes|jinja: true|jinja\?:|jinjaTemplate' \
  --include='*.rs' --include='*.ts' --include='*.tsx' --include='*.toml' --include='*.md' .

# Perf smoke (criterion 7 — ≥60k RPS floor on native route)
oha -c 120 -z 10s -m GET "http://127.0.0.1:3801/_test/native/X"
```

## Out of scope (per spec S14)

- Cache integration for native routes
- Nested loader composition for native routes (only leaf's loader runs)
- Hot reload of templates in dev (OnceLock; restart required)
- Dev-mode React fallback when `.jinja` is missing
- Streaming render via `Environment::stream`
- Loader-side prop validation via jsx-rustc
- JSX subset beyond A1's T0-T6

---

## Implementation cadence

**Dispatch one subagent per task. Never parallel.**

Each implementer brief includes:
- Task text verbatim
- Reference: `docs/superpowers/specs/2026-05-28-minijinja-dynamic-routes-design.md`
- Parent commit SHA
- ESCALATE list (per task's BLOCKED fallback)
- Reporting format: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED

Between each task:
- Spec-compliance reviewer subagent (verifies diff matches task)
- Code-quality reviewer subagent (`ecc:rust-reviewer` for Rust, `ecc:typescript-reviewer` for TS)
- Fix review findings before next task

After T7:
- Phase 6 scrutinize (orchestrator: re-run baselines + trace request path + perf smoke)
- Phase 7 wrap-up (commits + counts + partials)
