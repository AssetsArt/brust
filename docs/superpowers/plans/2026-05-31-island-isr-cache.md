# Island ISR Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an SSR island opt into an ISR-style cache so its React `renderToString` runs once per dev-supplied key (not per request); the frozen `{html, props}` pair is stored Rust-side and invalidated by key/tags.

**Architecture:** Compiler captures an `isr={{key, tags, revalidate}}` attr on `<Island>` into the islands manifest (`keyPath`/`tagsPath`/`revalidate`, paths resolved like `propsPath`). At request time the worker resolves the key from loader data and consults a Rust-side `CacheStore` (moka-backed, tag-indexed) over NAPI — hit serves the frozen pair, miss renders once and stores. A TS `cache.invalidate({key|tags})` API and a dev-reload cache clear complete it.

**Tech Stack:** Rust (`napi-rs`, `moka`, `parking_lot`), `swc` (jsx-rust-compiler), TypeScript/Bun runtime, React `react-dom/server.node`.

**Spec:** `docs/superpowers/specs/2026-05-31-island-isr-cache-design.md` (reviewed, fix-then-plan applied)

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `crates/brust/src/island_cache.rs` | `CacheStore` trait, `CachedIsland`, `MokaStore` (moka + tag→keys index) | Create |
| `crates/brust/Cargo.toml` | add `moka = { version = "0.12", features = ["sync"] }` | Modify |
| `crates/brust/src/lib.rs` | `island_cache` field on `State`; NAPI fns `island_cache_{get,set,invalidate,clear}`; `CachedIslandJs` | Modify |
| `crates/jsx-rust-compiler/src/lower.rs` | `expr_to_path` refactor; `isr` parsing; `JsxNode::Island` fields | Modify |
| `crates/jsx-rust-compiler/src/lib.rs` | `IslandMeta` fields; `collect_islands`/`number_islands`/`islands_to_json` | Modify |
| `crates/jsx-rust-compiler/src/emit_jinja.rs` | `JsxNode::Island` destructure (ignore new fields) | Modify |
| `runtime/islands/native-render.ts` | `NativeIslandEntry` fields; cache get/set in `resolveIslandContext` (injected `IslandCache`) | Modify |
| `runtime/routes.ts` | pass the real NAPI-backed `IslandCache` into `resolveIslandContext` | Modify |
| `runtime/cache.ts` | `cache.invalidate({key|tags})` dev-facing API | Create |
| `runtime/index.ts` | export `cache`; dev-reload `island_cache_clear()` alongside `resetWorkerPool` | Modify |
| `crates/brust/tests/island_cache_integration.rs` *(or bun integration)* | two-request single-render + tag-invalidate | Create |

---

## Task 1: `CacheStore` trait + `MokaStore` (Rust)

**Files:**
- Create: `crates/brust/src/island_cache.rs`
- Modify: `crates/brust/Cargo.toml`
- Modify: `crates/brust/src/lib.rs` (add `mod island_cache;`)

- [ ] **Step 1: Add the moka dependency**

In `crates/brust/Cargo.toml`, under `[dependencies]`:

```toml
moka = { version = "0.12", features = ["sync"] }
```

- [ ] **Step 2: Run to confirm it resolves**

Run: `cargo build -p brust`
Expected: compiles (moka downloaded). If a version is unavailable, run `cargo add moka --features sync -p brust` and pin whatever resolves; note the version in the commit.

- [ ] **Step 3: Write the failing test (store behavior)**

Create `crates/brust/src/island_cache.rs`:

```rust
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use moka::sync::Cache;
use parking_lot::Mutex;

/// A frozen server-rendered island fragment. `html` is the renderToString
/// output; `props` is the entity-encoded JSON props attribute. Both are stored
/// together so a cache hit serves a self-consistent (html, props) pair —
/// serving cached html against live props would break client hydration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedIsland {
    pub html: String,
    pub props: String,
    /// Lazy expiry: `None` = never expires (invalidate-only). Checked on `get`,
    /// matching the house pattern in `cache.rs` (`CachedEntry::is_expired`).
    pub expires_at: Option<Instant>,
}

impl CachedIsland {
    fn is_expired(&self) -> bool {
        matches!(self.expires_at, Some(t) if Instant::now() >= t)
    }
}

/// Backend-swappable island fragment cache. `MokaStore` is the in-memory impl;
/// a `RedisStore` can replace it later without touching the runtime or NAPI.
pub trait CacheStore: Send + Sync {
    fn get(&self, key: &str) -> Option<CachedIsland>;
    fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, html: String, props: String);
    fn invalidate_key(&self, key: &str);
    fn invalidate_tags(&self, tags: &[String]);
    fn clear(&self);
}

pub struct MokaStore {
    cache: Cache<String, CachedIsland>,
    /// tag → set of keys carrying that tag. Enables group invalidation, which
    /// moka has no native support for. Stale entries (key already evicted) are
    /// tolerated: invalidate pops a possibly-absent key (no-op).
    tag_index: Mutex<HashMap<String, HashSet<String>>>,
}

impl MokaStore {
    pub fn new(max_capacity: u64) -> Self {
        Self {
            cache: Cache::new(max_capacity),
            tag_index: Mutex::new(HashMap::new()),
        }
    }
}

impl CacheStore for MokaStore {
    fn get(&self, key: &str) -> Option<CachedIsland> {
        let v = self.cache.get(key)?;
        if v.is_expired() {
            self.cache.invalidate(key);
            return None;
        }
        Some(v)
    }

    fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, html: String, props: String) {
        let expires_at = ttl.map(|d| Instant::now() + d);
        if !tags.is_empty() {
            let mut idx = self.tag_index.lock();
            for tag in tags {
                idx.entry(tag.clone()).or_default().insert(key.to_string());
            }
        }
        self.cache.insert(
            key.to_string(),
            CachedIsland { html, props, expires_at },
        );
    }

    fn invalidate_key(&self, key: &str) {
        self.cache.invalidate(key);
    }

    fn invalidate_tags(&self, tags: &[String]) {
        let mut idx = self.tag_index.lock();
        for tag in tags {
            if let Some(keys) = idx.remove(tag) {
                for k in keys {
                    self.cache.invalidate(&k);
                }
            }
        }
    }

    fn clear(&self) {
        self.cache.invalidate_all();
        self.cache.run_pending_tasks();
        self.tag_index.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MokaStore {
        MokaStore::new(100)
    }
    fn sync(s: &MokaStore) {
        // moka invalidation is async; force pending ops for deterministic tests.
        s.cache.run_pending_tasks();
    }

    #[test]
    fn set_then_get_returns_frozen_pair() {
        let s = store();
        s.set("k1", &[], None, "<b>1</b>".into(), "{&quot;n&quot;:1}".into());
        let got = s.get("k1").expect("hit");
        assert_eq!(got.html, "<b>1</b>");
        assert_eq!(got.props, "{&quot;n&quot;:1}");
    }

    #[test]
    fn missing_key_is_none() {
        assert!(store().get("nope").is_none());
    }

    #[test]
    fn zero_ttl_expires_immediately() {
        let s = store();
        s.set("k", &[], Some(Duration::ZERO), "h".into(), "p".into());
        assert!(s.get("k").is_none(), "ttl=0 entry must read as expired");
    }

    #[test]
    fn future_ttl_is_a_hit() {
        let s = store();
        s.set("k", &[], Some(Duration::from_secs(60)), "h".into(), "p".into());
        assert!(s.get("k").is_some());
    }

    #[test]
    fn invalidate_key_removes_only_that_key() {
        let s = store();
        s.set("a", &[], None, "ha".into(), "pa".into());
        s.set("b", &[], None, "hb".into(), "pb".into());
        s.invalidate_key("a");
        sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_some());
    }

    #[test]
    fn invalidate_tags_removes_all_keys_in_group() {
        let s = store();
        s.set("a", &["products".into()], None, "ha".into(), "pa".into());
        s.set("b", &["products".into()], None, "hb".into(), "pb".into());
        s.set("c", &["other".into()], None, "hc".into(), "pc".into());
        s.invalidate_tags(&["products".into()]);
        sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_none());
        assert!(s.get("c").is_some(), "untagged group survives");
    }

    #[test]
    fn clear_empties_everything() {
        let s = store();
        s.set("a", &["t".into()], None, "h".into(), "p".into());
        s.clear();
        assert!(s.get("a").is_none());
    }

    #[test]
    fn trait_object_is_usable() {
        let s: Box<dyn CacheStore> = Box::new(store());
        s.set("k", &[], None, "h".into(), "p".into());
        assert!(s.get("k").is_some());
    }
}
```

Add to `crates/brust/src/lib.rs` (near the other `mod` declarations at the top):

```rust
mod island_cache;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p brust island_cache`
Expected: 8 tests pass. If `zero_ttl_expires_immediately` flakes, confirm `is_expired` uses `>=` (Duration::ZERO → `Instant::now() >= now` is true).

- [ ] **Step 5: Commit**

```bash
git add crates/brust/Cargo.toml crates/brust/src/island_cache.rs crates/brust/src/lib.rs
git commit -m "feat(cache): island ISR CacheStore trait + MokaStore (moka + tag index)"
```

**BLOCKED fallback:** if moka 0.12's `run_pending_tasks`/`invalidate_all` signatures differ, check the resolved version's docs (`cargo doc -p moka --open`) — the names are stable across 0.12.x. If moka pulls in an incompatible edition, pin `moka = "=0.12.8"`.

---

## Task 2: NAPI bridge + `State` field (Rust)

**Files:**
- Modify: `crates/brust/src/lib.rs`

- [ ] **Step 1: Add the `island_cache` field to `State`**

Find the `State` struct (around `lib.rs:38`, where `cache: Arc<LruCache>` lives) and add:

```rust
    island_cache: std::sync::Arc<crate::island_cache::MokaStore>,
```

In the `State` constructor/`new`, initialize it (default capacity 1000, mirroring `cache.rs:8`):

```rust
    island_cache: std::sync::Arc::new(crate::island_cache::MokaStore::new(1000)),
```

- [ ] **Step 2: Add the NAPI struct + functions**

Append near the other `#[napi]` fns (e.g. after `configure_islands_dir`, ~`lib.rs:303`):

```rust
use crate::island_cache::CacheStore;

#[napi(object)]
pub struct CachedIslandJs {
    pub html: String,
    pub props: String,
}

#[napi]
pub fn island_cache_get(key: String) -> Option<CachedIslandJs> {
    state()
        .island_cache
        .get(&key)
        .map(|v| CachedIslandJs { html: v.html, props: v.props })
}

#[napi]
pub fn island_cache_set(
    key: String,
    tags: Vec<String>,
    ttl_ms: Option<u32>,
    html: String,
    props: String,
) {
    let ttl = ttl_ms.map(|ms| std::time::Duration::from_millis(ms as u64));
    state().island_cache.set(&key, &tags, ttl, html, props);
}

#[napi]
pub fn island_cache_invalidate(key: Option<String>, tags: Option<Vec<String>>) {
    let c = &state().island_cache;
    if let Some(k) = key {
        c.invalidate_key(&k);
    }
    if let Some(t) = tags {
        c.invalidate_tags(&t);
    }
}

#[napi]
pub fn island_cache_clear() {
    state().island_cache.clear();
}
```

- [ ] **Step 3: Write a smoke test through `state()`**

In `crates/brust/src/lib.rs` test module (or a `#[cfg(test)]` block near the fns), add:

```rust
#[cfg(test)]
mod island_cache_napi_tests {
    use super::*;

    #[test]
    fn get_set_invalidate_roundtrip_through_state() {
        // Distinct keys avoid cross-test interference on the global singleton.
        island_cache_set(
            "napi:k1".into(),
            vec!["napi:t".into()],
            Some(60_000),
            "<i>x</i>".into(),
            "{}".into(),
        );
        let got = island_cache_get("napi:k1".into()).expect("hit");
        assert_eq!(got.html, "<i>x</i>");
        island_cache_invalidate(None, Some(vec!["napi:t".into()]));
        state().island_cache.clear(); // also exercises clear()
        assert!(island_cache_get("napi:k1".into()).is_none());
    }
}
```

- [ ] **Step 4: Run tests + full build**

Run: `cargo test -p brust island_cache && cargo build -p brust`
Expected: PASS + compiles. The `#[napi]` macros must expand cleanly.

- [ ] **Step 5: Commit**

```bash
git add crates/brust/src/lib.rs
git commit -m "feat(cache): NAPI bridge island_cache_{get,set,invalidate,clear} on State"
```

**BLOCKED fallback:** if `state()` is not the accessor name or `State::new` differs, grep the existing `cache: Arc<LruCache>` field and copy its exact init/access pattern — the island cache field mirrors it one-for-one.

---

## Task 3: Compiler — thread new fields through IR/manifest (no parsing yet)

**Files:**
- Modify: `crates/jsx-rust-compiler/src/lower.rs` (`JsxNode::Island` variant + construction)
- Modify: `crates/jsx-rust-compiler/src/lib.rs` (`IslandMeta`, `collect_islands`, `number_islands`, `islands_to_json`)
- Modify: `crates/jsx-rust-compiler/src/emit_jinja.rs` (island destructure)

This task adds the fields defaulting to `None` and fixes every match site so the crate compiles and all existing tests stay green. No `isr` parsing yet.

- [ ] **Step 1: Add fields to the IR node**

In `lower.rs`, find the `JsxNode::Island { ... }` enum variant definition and add three fields:

```rust
    Island {
        component: String,
        instance: usize,
        props_path: String,
        hydrate: String,
        ssr: bool,
        key_path: Option<String>,
        tags_path: Option<String>,
        revalidate: Option<u32>,
    },
```

In `lower_island` (`lower.rs:561`), update the construction to add the three fields as `None` for now:

```rust
    Ok(JsxNode::Island {
        component,
        instance: 0,
        props_path,
        hydrate,
        ssr,
        key_path: None,
        tags_path: None,
        revalidate: None,
    })
```

- [ ] **Step 2: Add fields to `IslandMeta` + thread through `lib.rs`**

In `lib.rs`, find `struct IslandMeta` (`~:32`) and add:

```rust
    pub key_path: Option<String>,
    pub tags_path: Option<String>,
    pub revalidate: Option<u32>,
```

In `collect_islands` (`lib.rs:94`), the `JsxNode::Island { ... }` destructure must bind the new fields and the constructed `IslandMeta` (`:101`) must copy them:

```rust
        JsxNode::Island {
            component, instance, props_path, hydrate, ssr,
            key_path, tags_path, revalidate,
        } => {
            out.push(IslandMeta {
                component: component.clone(),
                instance: *instance,
                props_path: props_path.clone(),
                ssr: *ssr,
                hydrate: hydrate.clone(),
                key_path: key_path.clone(),
                tags_path: tags_path.clone(),
                revalidate: *revalidate,
            });
        }
```

In `number_islands` (`lib.rs:68`), the `JsxNode::Island { instance, .. }` arm already uses `..` — no change needed (verify it does; if it destructures explicitly, add the fields).

- [ ] **Step 3: Emit new fields in `islands_to_json` (hand-rolled, no serde)**

In `islands_to_json` (`lib.rs:129`), after the `hydrate` field write and before the closing `}`, append the optional fields ONLY when present (keeps back-compat — islands without isr emit the same JSON as today):

```rust
        if let Some(kp) = &isl.key_path {
            out.push_str(",\"keyPath\":\"");
            out.push_str(&json_escape(kp));
            out.push('"');
        }
        if let Some(tp) = &isl.tags_path {
            out.push_str(",\"tagsPath\":\"");
            out.push_str(&json_escape(tp));
            out.push('"');
        }
        if let Some(r) = isl.revalidate {
            out.push_str(",\"revalidate\":");
            out.push_str(&r.to_string());
        }
```

(Insert these three blocks between the existing `hydrate` write and the `out.push_str("\"}")` / `out.push('}')` close — adjust so the closing brace is still emitted once.)

- [ ] **Step 4: Fix the `emit_jinja.rs` destructure + any other match sites**

In `emit_jinja.rs` the island arm destructures `JsxNode::Island { component, instance, props_path, hydrate, ssr }` (props_path may be `_`). Change its pattern to end with `..` so it ignores the new fields:

```rust
        JsxNode::Island { component, instance, hydrate, ssr, .. } => {
```

- [ ] **Step 5: Build — let the compiler list every remaining match site**

Run: `cargo build -p jsx-rust-compiler`
Expected: FAIL initially with `pattern does not mention fields key_path, tags_path, revalidate` at each exhaustive destructure. Fix each by appending `..` (for sites that don't need the fields) — known sites incl. test modules around `lower.rs:1281/1339/1959/1985`. Re-run until it compiles.

- [ ] **Step 6: Run the full compiler test suite**

Run: `cargo test -p jsx-rust-compiler`
Expected: ALL existing tests pass (behavior unchanged — fields default `None`, JSON unchanged when absent). Pay attention to `islands_to_json_golden` (`lib.rs:424`) — it must still match its golden (no isr → no new keys).

- [ ] **Step 7: Commit**

```bash
git add crates/jsx-rust-compiler/src/lower.rs crates/jsx-rust-compiler/src/lib.rs crates/jsx-rust-compiler/src/emit_jinja.rs
git commit -m "refactor(compiler): thread key_path/tags_path/revalidate through Island IR + manifest (None)"
```

---

## Task 4: Compiler — parse the `isr` attribute

**Files:**
- Modify: `crates/jsx-rust-compiler/src/lower.rs` (`expr_to_path` refactor, `isr` parsing, new error)
- Modify: error enum (`lib.rs` `ErrorKind`)

- [ ] **Step 1: Add the error variant**

In `lib.rs` `ErrorKind` (near `IslandPropsPathUnsupported`):

```rust
    #[error("`isr` attribute must be `{{ key: <path>, tags?: <path>, revalidate?: <number-literal> }}` with `ssr`")]
    IslandIsrUnsupported,
```

- [ ] **Step 2: Refactor `island_props_path` to expose a reusable `expr_to_path`**

In `lower.rs`, extract the `match strip_paren(e.as_ref()) { ... }` body (`:618-653`) into a standalone helper, and have `island_props_path` call it:

```rust
/// Resolve a JSX expression to a one-deep dotted path into loader data:
/// `Ident(x)` (x ∈ destructured) → `"x"`, `Member(root.leaf)` (root ∈
/// destructured) → `"root.leaf"`. Anything deeper/computed → `Err(err())`.
fn expr_to_path(
    e: &SwcExpr,
    scope: &Scope,
    err: &dyn Fn() -> LowerError,
) -> Result<String, LowerError> {
    match strip_paren(e) {
        SwcExpr::Ident(id) => {
            let name = id.sym.to_string();
            if scope.destructured.contains(&name) { Ok(name) } else { Err(err()) }
        }
        SwcExpr::Member(m) => {
            let MemberProp::Ident(leaf) = &m.prop else { return Err(err()); };
            let SwcExpr::Ident(root) = strip_paren(&m.obj) else { return Err(err()); };
            let root_name = root.sym.to_string();
            if scope.destructured.contains(&root_name) {
                Ok(format!("{root_name}.{}", leaf.sym))
            } else {
                Err(err())
            }
        }
        _ => Err(err()),
    }
}

fn island_props_path(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
) -> Result<String, LowerError> {
    let err = || LowerError::at(jsx_attr.span, ErrorKind::IslandPropsPathUnsupported);
    let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else { return Err(err()); };
    let JSXExpr::Expr(e) = &c.expr else { return Err(err()); };
    expr_to_path(e.as_ref(), scope, &err)
}
```

- [ ] **Step 3: Write the failing tests (isr parsing)**

Add to the `lower.rs` test module. Use the existing test scaffolding pattern (find how other `lower_*` tests build a `JSXElement` + `Scope` and call `lower_island`; mirror it exactly — likely a helper like `lower_island_src("<Island .../>")` or an AST builder). Pin the contract:

```rust
#[test]
fn lowers_isr_key_tags_revalidate() {
    // <Island component={Counter} props={data.counter} hydrate="load" ssr
    //   isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }} />
    let node = lower_island_fixture_with_isr(); // builds the element above
    let JsxNode::Island { key_path, tags_path, revalidate, ssr, .. } = node else { panic!() };
    assert!(ssr);
    assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
    assert_eq!(tags_path.as_deref(), Some("data.cacheTags"));
    assert_eq!(revalidate, Some(60));
}

#[test]
fn isr_without_ssr_is_rejected() {
    let err = lower_island_isr_no_ssr().unwrap_err();
    assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
}

#[test]
fn isr_dynamic_revalidate_is_rejected() {
    // isr={{ key: data.k, revalidate: data.ttl }} → revalidate must be a literal
    let err = lower_island_isr_dynamic_revalidate().unwrap_err();
    assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
}

#[test]
fn isr_key_only_is_allowed() {
    // tags + revalidate optional
    let node = lower_island_isr_key_only();
    let JsxNode::Island { key_path, tags_path, revalidate, .. } = node else { panic!() };
    assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
    assert_eq!(tags_path, None);
    assert_eq!(revalidate, None);
}
```

> Implementer note: replace the `lower_island_*` helper calls with whatever the existing test harness uses to drive `lower_island` (search the test module for how `props={data.counter}` islands are tested — e.g. `lowers_island_member_props_full_attrs` at `lower.rs:1952`). The assertions are the contract; the harness wiring is mechanical.

- [ ] **Step 4: Run to verify the tests fail**

Run: `cargo test -p jsx-rust-compiler isr`
Expected: FAIL (`isr` attr currently falls through `_ => {}` so all fields are `None`; the rejection tests don't error yet).

- [ ] **Step 5: Parse `isr` in `lower_island`**

In `lower_island`'s attr `match name.as_str()` (`lower.rs:497`), add an arm before the `_ => {}` fallthrough. Also add three locals (`key_path`/`tags_path`/`revalidate`) initialized to `None` next to `props_path`:

```rust
            "isr" => {
                let err = || LowerError::at(jsx_attr.span, ErrorKind::IslandIsrUnsupported);
                let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else { return Err(err()); };
                let JSXExpr::Expr(e) = &c.expr else { return Err(err()); };
                let SwcExpr::Object(obj) = strip_paren(e.as_ref()) else { return Err(err()); };
                for prop in &obj.props {
                    // Only `key: <expr>` shorthand-free properties; spreads/methods → error.
                    let PropOrSpread::Prop(p) = prop else { return Err(err()); };
                    let Prop::KeyValue(kv) = p.as_ref() else { return Err(err()); };
                    let pname = match &kv.key {
                        PropName::Ident(i) => i.sym.to_string(),
                        PropName::Str(s) => s.value.to_string_lossy().into_owned(),
                        _ => return Err(err()),
                    };
                    match pname.as_str() {
                        "key" => key_path = Some(expr_to_path(&kv.value, scope, &err)?),
                        "tags" => tags_path = Some(expr_to_path(&kv.value, scope, &err)?),
                        "revalidate" => {
                            // numeric LITERAL only — dynamic TTL out of scope.
                            let SwcExpr::Lit(swc_core::ecma::ast::Lit::Num(n)) =
                                strip_paren(&kv.value) else { return Err(err()); };
                            revalidate = Some(n.value as u32);
                        }
                        _ => return Err(err()),
                    }
                }
            }
```

Then enforce `isr ⟹ ssr` and thread the locals into the constructed node. Replace the construction from Task 3:

```rust
    if (key_path.is_some() || tags_path.is_some() || revalidate.is_some()) && !ssr {
        return Err(LowerError::at(el.opening.span, ErrorKind::IslandIsrUnsupported));
    }
    Ok(JsxNode::Island {
        component,
        instance: 0,
        props_path,
        hydrate,
        ssr,
        key_path,
        tags_path,
        revalidate,
    })
```

Add the swc imports near the top of `lower.rs` if not present: `use swc_core::ecma::ast::{Prop, PropOrSpread, PropName, Lit};` (check existing imports first — some may already be there).

- [ ] **Step 6: Run the isr tests + full suite**

Run: `cargo test -p jsx-rust-compiler`
Expected: the 4 new isr tests PASS; all prior tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/jsx-rust-compiler/src/lower.rs crates/jsx-rust-compiler/src/lib.rs
git commit -m "feat(compiler): parse isr={{key,tags,revalidate}} on <Island> (literal revalidate, ssr-required)"
```

**BLOCKED fallback:** swc's `ObjectLit`/`Prop` enum shapes vary by `swc_core` version. If `Prop::KeyValue`/`PropName::Ident` paths differ, run `cargo doc -p swc_core --open` or check an existing object-literal traversal in the crate. The tests pin the behavior; only the enum-walk wiring changes. If object-literal parsing proves too costly, the FALLBACK is to accept `isr` as THREE separate attrs (`isrKey={data.cacheKey} isrTags={data.cacheTags} isrRevalidate={60}`) — each parsed with the existing single-attr machinery (`island_props_path` for the two paths, a tiny literal reader for revalidate). Update the spec's authoring example if you take this path.

---

## Task 5: Runtime — cache get/set in `resolveIslandContext` (TS)

**Files:**
- Modify: `runtime/islands/native-render.ts`
- Test: `runtime/islands/native-render.test.ts`

- [ ] **Step 1: Extend `NativeIslandEntry` + define the injected cache interface**

In `native-render.ts`, add to the `NativeIslandEntry` interface:

```ts
  keyPath?: string
  tagsPath?: string
  revalidate?: number
```

Add an injectable cache port (keeps the module unit-testable without the native addon):

```ts
/** Rust-side island fragment cache, injected so tests can stub it. */
export interface IslandCache {
  get(key: string): { html: string; props: string } | null
  set(key: string, tags: string[], ttlMs: number | undefined, html: string, props: string): void
}
```

- [ ] **Step 2: Write the failing tests**

In `native-render.test.ts`, add (mirror the existing test setup for `resolveIslandContext` — manifest fixtures + a component source):

```ts
import { resolveIslandContext, type IslandCache, type NativeIslandEntry } from './native-render.ts'

function fakeCache() {
  const store = new Map<string, { html: string; props: string }>()
  const calls = { get: 0, set: 0 }
  const cache: IslandCache = {
    get(k) { calls.get++; return store.get(k) ?? null },
    set(k, _tags, _ttl, html, props) { calls.set++; store.set(k, { html, props }) },
  }
  return { cache, calls, store }
}

const ssrIsrEntry: NativeIslandEntry = {
  component: 'Counter', instance: 0, propsPath: 'counter', ssr: true,
  hydrate: 'load', sourcePath: FIXTURE_COUNTER_PATH, // reuse the existing fixture path
  keyPath: 'cacheKey', tagsPath: 'cacheTags',
}

test('isr island: miss renders once and writes cache', async () => {
  const { cache, calls } = fakeCache()
  const data = { counter: { n: 1 }, cacheKey: 'k1', cacheTags: ['t'] }
  const out = await resolveIslandContext([ssrIsrEntry], data, cache)
  expect(calls.get).toBe(1)
  expect(calls.set).toBe(1)
  expect(out.island_0_html).toBeDefined()
})

test('isr island: hit serves frozen pair without rendering', async () => {
  const { cache, calls } = fakeCache()
  const data = { counter: { n: 1 }, cacheKey: 'k1', cacheTags: ['t'] }
  await resolveIslandContext([ssrIsrEntry], data, cache) // populate
  const before = calls.set
  // Mutate live props; a hit must still serve the FROZEN props, not these.
  const out = await resolveIslandContext([ssrIsrEntry], { ...data, counter: { n: 999 } }, cache)
  expect(calls.set).toBe(before) // no second write → no second render
  expect(out.island_0_props).toBe(out.island_0_props) // frozen, from cache
})

test('isr island: undefined key falls back to uncached render', async () => {
  const { cache, calls } = fakeCache()
  const data = { counter: { n: 1 } } // no cacheKey
  const out = await resolveIslandContext([ssrIsrEntry], data, cache)
  expect(calls.get).toBe(0)
  expect(calls.set).toBe(0)
  expect(out.island_0_html).toBeDefined() // still rendered
})

test('non-isr ssr island is unchanged (renders, no cache calls)', async () => {
  const { cache, calls } = fakeCache()
  const plain: NativeIslandEntry = { ...ssrIsrEntry, keyPath: undefined, tagsPath: undefined }
  await resolveIslandContext([plain], { counter: { n: 1 } }, cache)
  expect(calls.get).toBe(0)
  expect(calls.set).toBe(0)
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/detoro/code/brust && bun test runtime/islands/native-render.test.ts`
Expected: FAIL — `resolveIslandContext` takes 2 args, tests pass 3; cache logic absent.

- [ ] **Step 4: Implement the cache path**

Change the `resolveIslandContext` signature to accept an optional cache, and wrap the ssr render block (`native-render.ts:122-150`):

```ts
export async function resolveIslandContext(
  manifest: NativeIslandEntry[],
  data: unknown,
  cache?: IslandCache,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of manifest) {
    const props = pathInto(data, entry.propsPath)
    const propsAttr = entityEncode(JSON.stringify(props ?? null) ?? 'null')
    out['island_' + entry.instance + '_props'] = propsAttr
    if (!entry.ssr) continue

    // ISR cache fast path: dev-supplied key resolved from loader data.
    let key: string | undefined
    if (cache && entry.keyPath) {
      const k = pathInto(data, entry.keyPath)
      if (typeof k === 'string') {
        key = k
        const hit = cache.get(key)
        if (hit) {
          out['island_' + entry.instance + '_html'] = hit.html
          out['island_' + entry.instance + '_props'] = hit.props // FROZEN pair
          continue
        }
      } else if (k !== undefined) {
        console.warn(`[brust] island "${entry.component}" isr key resolved to non-string; rendering uncached`)
      }
    }

    try {
      let Component = componentCache.get(entry.sourcePath)
      if (Component === undefined) {
        const mod = await import(entry.sourcePath)
        Component = mod.default ?? mod
        componentCache.set(entry.sourcePath, Component)
      }
      if (typeof Component !== 'function') {
        throw new Error(`island "${entry.component}" source has no default-exported component`)
      }
      const html = renderToString(createElement(Component as any, (props ?? undefined) as any))
      out['island_' + entry.instance + '_html'] = html

      // Write-through on a miss (only when we resolved a real key).
      if (cache && key) {
        let tags: string[] = []
        if (entry.tagsPath) {
          const t = pathInto(data, entry.tagsPath)
          if (Array.isArray(t)) tags = t as string[]
          else if (t !== undefined) console.warn(`[brust] island "${entry.component}" isr tags not an array; ignoring`)
        }
        const ttlMs = entry.revalidate !== undefined ? entry.revalidate * 1000 : undefined
        cache.set(key, tags, ttlMs, html, propsAttr)
      }
    } catch (e) {
      console.error(`[brust] ssr island "${entry.component}" renderToString failed; degrading to client-only:`, e)
    }
  }
  return out
}
```

Note: this hoists the `propsAttr` computation above the ssr branch (it was already computed for `_props`) so the cache stores the SAME attr string the client hydrates with — invariant 1.

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test runtime/islands/native-render.test.ts`
Expected: all tests PASS (new + existing). The existing 2-arg callers still work (`cache` is optional).

- [ ] **Step 6: Commit**

```bash
git add runtime/islands/native-render.ts runtime/islands/native-render.test.ts
git commit -m "feat(runtime): ISR cache get/set in resolveIslandContext (frozen html+props, injected cache)"
```

---

## Task 6: Runtime — wire the real NAPI cache into `routes.ts`

**Files:**
- Modify: `runtime/routes.ts`

- [ ] **Step 1: Build the NAPI-backed cache adapter + pass it in**

In `routes.ts`, near the top where `native` (the addon) is imported and where `resolveIslandContext` is called (`:598`), construct the adapter once (module scope) and pass it:

```ts
const islandCache: import('./islands/native-render.ts').IslandCache = {
  get(key) {
    return (native as any).islandCacheGet(key) ?? null
  },
  set(key, tags, ttlMs, html, props) {
    ;(native as any).islandCacheSet(key, tags, ttlMs ?? undefined, html, props)
  },
}
```

Change the call site (`:598`):

```ts
          const extra = await resolveIslandContext(manifest, rt, islandCache)
```

- [ ] **Step 2: Verify the addon exports the camelCase names**

Run: `cd /Users/detoro/code/brust && node -e "const n=require('./runtime/index.js'); console.log(typeof n)" 2>/dev/null || true`
Then confirm the napi names: napi-rs maps `island_cache_get` → `islandCacheGet`. Grep the generated `runtime/index.d.ts` (after a rebuild) for `islandCacheGet`. If the addon isn't rebuilt yet, that's expected — Task is integration-gated; the type/contract is correct per napi-rs snake→camel convention.

- [ ] **Step 3: Type-check**

Run: `bun run typecheck` (or the repo's TS check command — check `package.json` scripts; fall back to `bunx tsc --noEmit -p tsconfig.json`)
Expected: PASS. `(native as any)` avoids needing the regenerated `.d.ts`.

- [ ] **Step 4: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(runtime): pass NAPI-backed IslandCache into resolveIslandContext"
```

**BLOCKED fallback:** if `native` is not the in-scope addon binding in `routes.ts`, grep for `napiRenderJinja` usage in the file (`:612`) — use the SAME binding it calls through. That binding is the addon.

---

## Task 7: Dev-facing `cache.invalidate` API + dev-reload clear

**Files:**
- Create: `runtime/cache.ts`
- Modify: `runtime/index.ts` (export `cache`; dev-reload clear)

- [ ] **Step 1: Write the failing test**

Create `runtime/cache.test.ts`:

```ts
import { test, expect, mock } from 'bun:test'

test('cache.invalidate forwards key + tags to the native bridge', async () => {
  const calls: any[] = []
  mock.module('./native-binding.ts', () => ({
    islandCacheInvalidate: (key?: string, tags?: string[]) => calls.push({ key, tags }),
  }))
  const { cache } = await import('./cache.ts')
  cache.invalidate({ tags: ['user_12:product'] })
  cache.invalidate({ key: 'user_12:product_5' })
  expect(calls).toEqual([
    { key: undefined, tags: ['user_12:product'] },
    { key: 'user_12:product_5', tags: undefined },
  ])
})
```

> Implementer note: `runtime/cache.ts` must import the addon through whatever indirection the repo already uses (find how `native` is resolved — likely a `native-binding`/`load-addon` module). Mirror that import so the mock target matches. If there's no separate binding module, have `cache.ts` import the addon the same way `routes.ts` does and adjust the `mock.module` target accordingly.

- [ ] **Step 2: Run to verify failure**

Run: `bun test runtime/cache.test.ts`
Expected: FAIL — `cache.ts` does not exist.

- [ ] **Step 3: Implement `runtime/cache.ts`**

```ts
// Dev-facing island ISR cache control. Invalidation crosses to the Rust-side
// store (shared across the worker pool) via NAPI. Call from action/api/loader.
import { native } from './native-binding.ts' // adjust to the repo's addon import

export interface InvalidateArgs {
  key?: string
  tags?: string[]
}

export const cache = {
  /** Evict by exact key and/or by tag group. Both optional; both may be given. */
  invalidate(args: InvalidateArgs): void {
    ;(native as any).islandCacheInvalidate(args.key, args.tags)
  },
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test runtime/cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Export `cache` + clear island cache on dev reload**

In `runtime/index.ts`: export the API (`export { cache } from './cache.ts'`) near the other public exports.

Find the dev reload `terminateAll` path (`index.ts:480`, where `resetWorkerPool()` is called) and clear the island cache alongside it (invariant 7):

```ts
              const dropped = (native as any).resetWorkerPool?.() ?? 0
              ;(native as any).islandCacheClear?.() // drop stale frozen islands after a source edit
```

- [ ] **Step 6: Type-check + commit**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

```bash
git add runtime/cache.ts runtime/cache.test.ts runtime/index.ts
git commit -m "feat(runtime): cache.invalidate({key,tags}) dev API + clear island cache on dev reload"
```

---

## Task 8: `ServeOptions.tuning.islandCacheCapacity` knob

**Files:**
- Modify: `crates/brust/src/lib.rs` (read capacity from tuning when constructing `MokaStore`)
- Modify: the TS `ServeOptions.tuning` type + plumbing (mirror an existing tuning knob, e.g. `connQueueCap`)

- [ ] **Step 1: Find an existing tuning knob and mirror it**

Grep for `connQueueCap` (added in 0.1.6) across Rust + TS. It is the template: a `tuning` field surfaced in TS `ServeOptions`, passed through `run()`, read Rust-side at configure time. Add `islandCacheCapacity?: number` (default 1000) the same way.

- [ ] **Step 2: Apply capacity at construction**

Where `MokaStore::new(1000)` is set on `State` (Task 2), make it read the configured capacity (default 1000 if unset), matching how the other tunables are applied. If tunables are applied post-`new` via a `configure_*` NAPI, add `MokaStore` capacity there using moka's policy (or store capacity and rebuild — simplest: construct `State.island_cache` after tuning is known, mirroring `connQueueCap`'s timing).

- [ ] **Step 3: Test (mirror the existing tuning test)**

Find the test that asserts `connQueueCap` plumbs through; add an analogous one for `islandCacheCapacity`. Run the relevant suite (`cargo test -p brust` + the TS tuning test).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(serve): ServeOptions.tuning.islandCacheCapacity (default 1000)"
```

**BLOCKED fallback:** if wiring the capacity through the existing tuning timing is fiddly, ship the default-1000 constant (Task 2 already has it) and file the knob as a deferred follow-up — the knob is a nice-to-have, not load-bearing for the feature. Note the deferral in the wrap-up.

---

## Task 9: Integration test (separate file — port-race flake discipline)

**Files:**
- Create: a bun integration test under the repo's integration dir (find where native-island integration tests live, e.g. `runtime/islands/*.integration.test.ts` or `tests/`)

Per memory [[native-island-integration-flake]]: run integration files SEPARATELY (port-race flake when combined).

- [ ] **Step 1: Write the integration test**

Drive a real native-jinja route with an isr SSR island. Assert:
1. Two requests with the same resolved key produce IDENTICAL html, and the island component's render runs ONCE (instrument via a module-level counter the fixture component increments, or assert via cache stats if exposed).
2. `cache.invalidate({ tags })` then a third request re-renders (counter increments again).
3. The served markup hydrates without a React mismatch warning (assert no `Warning: ... did not match` in captured console — reuse the existing island hydration test harness).

```ts
// Pseudocode skeleton — wire to the repo's existing native-island integration harness.
import { test, expect } from 'bun:test'
import { cache } from '../cache.ts'

test('isr island renders once across two same-key requests', async () => {
  const { server, renderCount } = await startFixtureServer('isr-counter')
  const r1 = await fetch(server.url + '/p/5')
  const r2 = await fetch(server.url + '/p/5')
  expect(await r1.text()).toEqual(await r2.text())
  expect(renderCount()).toBe(1)
  cache.invalidate({ tags: ['product:5'] })
  await fetch(server.url + '/p/5')
  expect(renderCount()).toBe(2)
  await server.stop()
})
```

- [ ] **Step 2: Run it ALONE**

Run: `bun test runtime/islands/isr-cache.integration.test.ts`
Expected: PASS. Run it 3× to confirm non-flaky (memory: run flaky-suspects 5×, but 3× is the floor here).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(integration): isr island renders once per key; tag-invalidate re-renders"
```

**BLOCKED fallback:** if a from-scratch fixture server is too heavy, instrument at the `resolveIslandContext` level instead (in-process: call it twice with the same data + a real `MokaStore`-backed adapter via a tiny NAPI round-trip, assert one render via a spy on the fixture component). The unit tests in Task 5 already cover the cache logic; this integration test's unique value is the hydration-no-mismatch assertion — keep that.

---

## Self-review

**Spec coverage:**
- Compiler `isr` capture → Tasks 3, 4 ✅
- `keyPath`/`tagsPath`/`revalidate` in manifest → Task 3 ✅
- Runtime cache get/set + frozen pair → Task 5 ✅
- Degenerate key/tags handling → Task 5 (tests + impl) ✅
- Rust `CacheStore` trait + `MokaStore` + tag index → Task 1 ✅
- NAPI `get/set/invalidate/clear` → Task 2 ✅
- `cache.invalidate` dev API → Task 7 ✅
- Dev-reload clear (invariant 7) → Task 7 ✅
- Cold-miss stampede (invariant 6) → accepted, no code needed; documented ✅
- TTL/`revalidate` pure-evict → Task 1 (`expires_at` lazy) + Task 5 (ttlMs) ✅
- `islandCacheCapacity` tuning knob → Task 8 ✅
- Integration: one-render + invalidate + hydration → Task 9 ✅
- Page-level route cache, SSG/build-time, SWR, request-derived-key loader-skip → **out of scope (spec non-goals)**; no tasks, intentional.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to". Each code step shows code. Test-harness wiring in Tasks 4 & 9 is flagged as mechanical with the contract pinned by assertions — acceptable (the exact swc/server-fixture wiring depends on existing in-repo helpers the implementer reads).

**Type consistency:** `CachedIsland{html,props,expires_at}` (Rust) ↔ `CachedIslandJs{html,props}` (NAPI) ↔ `{html,props}` (TS `IslandCache.get`). `island_cache_set(key,tags,ttl_ms,html,props)` ↔ TS `set(key,tags,ttlMs,html,props)`. `keyPath`/`tagsPath`/`revalidate` consistent across IR (`key_path` snake) → manifest JSON (`keyPath` camel) → TS (`keyPath`). NAPI snake `island_cache_get` → camel `islandCacheGet` (napi-rs convention) used in TS. Consistent.

**Build order:** Tasks 1→2 (Rust cache+NAPI) and 3→4 (compiler) are independent; 5 depends on the `IslandCache` shape (self-contained, no addon); 6 depends on 2+5; 7 depends on 2; 8 depends on 2; 9 depends on all. Sequential execution as numbered is safe.
