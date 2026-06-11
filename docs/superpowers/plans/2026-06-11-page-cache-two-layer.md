# Two-Layer Page Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework brust's page cache into one `cache` object holding two Rust-stored layers — L1 declarative (header/cookie expression keying, native zero-Bun cacheable) and L2 programmatic (worker `key()` fn returning `{key,tags,ttl}`) — routed per-request by `bypass`, with `cache.invalidate` fanning out to the new page cache.

**Architecture:** Both caches are moka instances in the Rust addon singleton (`ResponseCache` = L1 structured key; new `PageCache` = L2 string key + tag index). A new pure-Rust expression evaluator (`key_expr.rs`) compiles `prefix`/`bypass` once at route install and evaluates per-request against headers/cookies. The native render path already writes a framed `[meta_len][meta][body]` payload into the SAB; the worker captures it (`slotView.subarray(0,len)`) for `pageCacheSet` and replays cached bytes on a hit — no `napi_render_jinja` change.

**Tech Stack:** Rust (hyper, moka, parking_lot, serde, napi-rs), Bun/TypeScript runtime, minijinja native templates.

**Spec:** `docs/superpowers/specs/2026-06-11-page-cache-two-modes-design.md`

**Base commit:** `7231242` (spec commit on branch `feat/page-cache-two-layer`)

**Build/test commands (this repo):**
- Rust unit: `cargo test --workspace --locked`
- Rust single: `cargo test -p brust-core <name> -- --nocolor`
- Lint gate: `cargo fmt --all --check` + `cargo clippy --workspace --all-targets --locked -- -D warnings`
- Rebuild addon after Rust change (REQUIRED before bun tests see it): `cd runtime && bun run build:debug && cd ..`
- TS lint gate: `bun run ci` (biome)
- TS tests: `bun test runtime/` and `bun test tests/<file>.test.ts`

---

## Task 1: `key_expr.rs` — L1 expression parser + evaluator

**Files:**
- Create: `crates/brust-core/src/cache/key_expr.rs`
- Modify: `crates/brust-core/src/cache/mod.rs` (add `pub mod key_expr;`)

Pure module — no hyper/napi/moka deps. The evaluator takes borrowed request data so the server can call it with whatever it has.

- [ ] **Step 1: Write failing tests** (append to the new file under `#[cfg(test)]`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>() -> EvalCtx<'a> {
        EvalCtx {
            headers: &[("authorization", "Bearer x"), ("x-tenant", "acme")],
            cookies: &[("session", "s1"), ("currency", "thb")],
            query: &[("sort", "new")],
            params: &[("id", "42")],
            method: "GET",
            host: "shop.example.com",
            scheme: "https",
        }
    }

    fn ev(src: &str) -> String {
        Expr::parse(src).unwrap().eval(&ctx())
    }

    #[test] fn accessor_header_case_insensitive() { assert_eq!(ev("header(Authorization)"), "Bearer x"); }
    #[test] fn accessor_cookie() { assert_eq!(ev("cookie(currency)"), "thb"); }
    #[test] fn accessor_absent_is_empty() { assert_eq!(ev("cookie(nope)"), ""); }
    #[test] fn accessor_query_param_request() {
        assert_eq!(ev("query(sort)"), "new");
        assert_eq!(ev("param(id)"), "42");
        assert_eq!(ev("request(host)"), "shop.example.com");
        assert_eq!(ev("request(method)"), "GET");
        assert_eq!(ev("request(scheme)"), "https");
    }
    #[test] fn or_first_non_empty() { assert_eq!(ev("or(cookie(nope), header(x-tenant), \"d\")"), "acme"); }
    #[test] fn or_all_empty() { assert_eq!(ev("or(cookie(nope), header(nope))"), ""); }
    #[test] fn and_all_present_joins_unit_sep() { assert_eq!(ev("and(request(host), cookie(currency))"), "shop.example.com\u{1f}thb"); }
    #[test] fn and_any_empty_is_empty() { assert_eq!(ev("and(request(host), cookie(nope))"), ""); }
    #[test] fn concat_no_separator() { assert_eq!(ev("concat(\"v2-\", cookie(currency))"), "v2-thb"); }
    #[test] fn eq_returns_value_or_a() {
        assert_eq!(ev("eq(request(method), \"GET\", \"yes\")"), "yes");
        assert_eq!(ev("eq(request(method), \"POST\", \"yes\")"), "");
        assert_eq!(ev("eq(cookie(currency), \"thb\")"), "thb");
    }
    #[test] fn lower_upper() {
        assert_eq!(ev("upper(cookie(currency))"), "THB");
        assert_eq!(ev("lower(request(host))"), "shop.example.com");
    }
    #[test] fn nested() { assert_eq!(ev("or(and(cookie(nope), cookie(currency)), \"fb\")"), "fb"); }

    #[test] fn reject_uuid() { assert!(Expr::parse("uuid(v4)").is_err()); }
    #[test] fn reject_timestamp() { assert!(Expr::parse("timestamp()").is_err()); }
    #[test] fn reject_unknown_ident() { assert!(Expr::parse("frobnicate(x)").is_err()); }
    #[test] fn reject_empty_or() { assert!(Expr::parse("or()").is_err()); }
    #[test] fn reject_empty_and() { assert!(Expr::parse("and()").is_err()); }
    #[test] fn reject_unbalanced() { assert!(Expr::parse("or(cookie(x)").is_err()); }
    #[test] fn reject_accessor_bad_arity() { assert!(Expr::parse("header(a, b)").is_err()); }
    #[test] fn reject_eq_bad_arity() { assert!(Expr::parse("eq(a)").is_err()); }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p brust-core key_expr 2>&1 | tail -5`
Expected: compile error (`Expr`, `EvalCtx` not found).

- [ ] **Step 3: Implement the parser + evaluator** (prepend above the test module)

```rust
//! L1 cache-key expression grammar (spec: docs/superpowers/specs/2026-06-11-page-cache-two-modes-design.md).
//! Bare expression → String ("" = absent/false). Compiled once at route install,
//! evaluated per request. Deterministic-only: uuid()/timestamp() rejected so a
//! cache key is always reproducible.

/// Borrowed request data the evaluator reads. Slices, not maps — the caller
/// already holds these as small vecs at the cache-decision site.
pub struct EvalCtx<'a> {
    pub headers: &'a [(&'a str, &'a str)],
    pub cookies: &'a [(&'a str, &'a str)],
    pub query: &'a [(&'a str, &'a str)],
    pub params: &'a [(&'a str, &'a str)],
    pub method: &'a str,
    pub host: &'a str,
    pub scheme: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    Header(String),
    Cookie(String),
    Query(String),
    Param(String),
    Request(String),
    Env(String), // resolved at parse (frozen): stores the value, not the name
    Lit(String),
    Or(Vec<Expr>),
    And(Vec<Expr>),
    Concat(Vec<Expr>),
    Eq(Box<Expr>, Box<Expr>, Option<Box<Expr>>),
    Lower(Box<Expr>),
    Upper(Box<Expr>),
}

pub type ParseError = String;

impl Expr {
    pub fn parse(src: &str) -> Result<Expr, ParseError> {
        let mut p = Parser { s: src.as_bytes(), i: 0 };
        p.skip_ws();
        let e = p.expr()?;
        p.skip_ws();
        if p.i != p.s.len() {
            return Err(format!("cache expression: trailing input at byte {}", p.i));
        }
        Ok(e)
    }

    pub fn eval(&self, ctx: &EvalCtx) -> String {
        fn lookup(pairs: &[(&str, &str)], name: &str) -> String {
            pairs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| (*v).to_string())
                .unwrap_or_default()
        }
        match self {
            Expr::Header(n) => lookup(ctx.headers, n),
            Expr::Cookie(n) => lookup(ctx.cookies, n),
            Expr::Query(n) => lookup(ctx.query, n),
            Expr::Param(n) => lookup(ctx.params, n),
            Expr::Request(f) => match f.as_str() {
                "host" => ctx.host.to_string(),
                "method" => ctx.method.to_string(),
                "scheme" => ctx.scheme.to_string(),
                "path" => String::new(), // path handled by CacheKey.path; request(path) reads "" here
                _ => String::new(),
            },
            Expr::Env(v) => v.clone(),
            Expr::Lit(v) => v.clone(),
            Expr::Or(args) => args
                .iter()
                .map(|a| a.eval(ctx))
                .find(|v| !v.is_empty())
                .unwrap_or_default(),
            Expr::And(args) => {
                let vals: Vec<String> = args.iter().map(|a| a.eval(ctx)).collect();
                if vals.iter().all(|v| !v.is_empty()) {
                    vals.join("\u{1f}")
                } else {
                    String::new()
                }
            }
            Expr::Concat(args) => args.iter().map(|a| a.eval(ctx)).collect(),
            Expr::Eq(a, b, v) => {
                let av = a.eval(ctx);
                if av == b.eval(ctx) {
                    v.as_ref().map(|x| x.eval(ctx)).unwrap_or(av)
                } else {
                    String::new()
                }
            }
            Expr::Lower(a) => a.eval(ctx).to_ascii_lowercase(),
            Expr::Upper(a) => a.eval(ctx).to_ascii_uppercase(),
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn expr(&mut self) -> Result<Expr, ParseError> {
        self.skip_ws();
        if self.i < self.s.len() && (self.s[self.i] == b'\'' || self.s[self.i] == b'"') {
            return self.string_lit().map(Expr::Lit);
        }
        let ident = self.ident()?;
        self.skip_ws();
        if self.i >= self.s.len() || self.s[self.i] != b'(' {
            return Err(format!("cache expression: expected '(' after '{ident}'"));
        }
        self.i += 1; // consume '('
        let args = self.args()?;
        self.expect(b')')?;
        self.build(&ident, args)
    }

    fn args(&mut self) -> Result<Vec<Expr>, ParseError> {
        let mut out = Vec::new();
        self.skip_ws();
        if self.i < self.s.len() && self.s[self.i] == b')' {
            return Ok(out); // empty arg list
        }
        loop {
            out.push(self.expr()?);
            self.skip_ws();
            match self.s.get(self.i) {
                Some(b',') => {
                    self.i += 1;
                    self.skip_ws();
                }
                Some(b')') => return Ok(out),
                _ => return Err("cache expression: expected ',' or ')'".into()),
            }
        }
    }

    fn build(&self, ident: &str, mut args: Vec<Expr>) -> Result<Expr, ParseError> {
        let one_str = |args: &[Expr]| -> Result<String, ParseError> {
            match args {
                [Expr::Lit(s)] => Ok(s.clone()),
                [_] => Err(format!("cache expression: {ident}() argument must be a string literal")),
                _ => Err(format!("cache expression: {ident}() takes exactly one argument")),
            }
        };
        match ident {
            "header" => Ok(Expr::Header(one_str(&args)?)),
            "cookie" => Ok(Expr::Cookie(one_str(&args)?)),
            "query" => Ok(Expr::Query(one_str(&args)?)),
            "param" => Ok(Expr::Param(one_str(&args)?)),
            "request" => Ok(Expr::Request(one_str(&args)?)),
            "env" => Ok(Expr::Env(std::env::var(one_str(&args)?).unwrap_or_default())),
            "or" => {
                if args.is_empty() { return Err("cache expression: or() needs ≥1 argument".into()); }
                Ok(Expr::Or(args))
            }
            "and" => {
                if args.is_empty() { return Err("cache expression: and() needs ≥1 argument".into()); }
                Ok(Expr::And(args))
            }
            "concat" => {
                if args.is_empty() { return Err("cache expression: concat() needs ≥1 argument".into()); }
                Ok(Expr::Concat(args))
            }
            "lower" | "upper" => {
                if args.len() != 1 { return Err(format!("cache expression: {ident}() takes one argument")); }
                let a = Box::new(args.remove(0));
                Ok(if ident == "lower" { Expr::Lower(a) } else { Expr::Upper(a) })
            }
            "eq" => match args.len() {
                2 => { let b = Box::new(args.remove(1)); let a = Box::new(args.remove(0)); Ok(Expr::Eq(a, b, None)) }
                3 => { let v = Box::new(args.remove(2)); let b = Box::new(args.remove(1)); let a = Box::new(args.remove(0)); Ok(Expr::Eq(a, b, Some(v))) }
                _ => Err("cache expression: eq() takes 2 or 3 arguments".into()),
            },
            "uuid" | "timestamp" => Err(format!(
                "cache expression: {ident}() is non-deterministic and not allowed in cache keys"
            )),
            other => Err(format!("cache expression: unknown function '{other}'")),
        }
    }

    fn ident(&mut self) -> Result<String, ParseError> {
        let start = self.i;
        while self.i < self.s.len()
            && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_')
        {
            self.i += 1;
        }
        if self.i == start {
            return Err(format!("cache expression: expected identifier at byte {start}"));
        }
        Ok(String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }

    fn string_lit(&mut self) -> Result<String, ParseError> {
        let quote = self.s[self.i];
        self.i += 1;
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != quote {
            self.i += 1;
        }
        if self.i >= self.s.len() {
            return Err("cache expression: unterminated string literal".into());
        }
        let out = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
        self.i += 1; // closing quote
        Ok(out)
    }

    fn expect(&mut self, c: u8) -> Result<(), ParseError> {
        self.skip_ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("cache expression: expected '{}'", c as char))
        }
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p brust-core key_expr 2>&1 | tail -8`
Expected: all ~22 tests PASS.

- [ ] **Step 5: Lint + commit**

```bash
cargo fmt --all && cargo clippy -p brust-core --all-targets --locked -- -D warnings 2>&1 | tail -3
git add crates/brust-core/src/cache/key_expr.rs crates/brust-core/src/cache/mod.rs
git commit -m "feat(cache): L1 key-expression parser + evaluator (key_expr.rs)"
```

**BLOCKED fallback:** if `cache/mod.rs` doesn't exist (the cache module is declared elsewhere, e.g. in `lib.rs` as `pub mod cache { ... }` or `cache.rs`), `rg "mod (response_cache|island_cache)" crates/brust-core/src` to find the real declaration site and add `pub mod key_expr;` there.

---

## Task 2: `page_cache.rs` — L2 store (PageCache)

**Files:**
- Create: `crates/brust-core/src/cache/page_cache.rs`
- Modify: `crates/brust-core/src/cache/mod.rs` (add `pub mod page_cache;`)

Mirror `island_cache.rs::MokaStore` exactly (tag_index, set-before-index ordering, lazy expiry, lock-drop-before-invalidate) but store `Vec<u8>` payload instead of `(html, props)`.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> PageCache { PageCache::new(100) }
    fn sync(s: &PageCache) { s.cache.run_pending_tasks(); }

    #[test] fn set_then_get_returns_payload() {
        let s = store();
        s.set("k1", &[], None, b"PAYLOAD".to_vec());
        assert_eq!(s.get("k1").as_deref(), Some(&b"PAYLOAD"[..]));
    }
    #[test] fn missing_is_none() { assert!(store().get("nope").is_none()); }
    #[test] fn zero_ttl_expires_immediately() {
        let s = store();
        s.set("k", &[], Some(Duration::ZERO), b"x".to_vec());
        assert!(s.get("k").is_none());
    }
    #[test] fn future_ttl_is_hit() {
        let s = store();
        s.set("k", &[], Some(Duration::from_secs(60)), b"x".to_vec());
        assert!(s.get("k").is_some());
    }
    #[test] fn invalidate_key_removes_one() {
        let s = store();
        s.set("a", &[], None, b"a".to_vec());
        s.set("b", &[], None, b"b".to_vec());
        s.invalidate_key("a"); sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_some());
    }
    #[test] fn invalidate_tags_removes_group() {
        let s = store();
        s.set("a", &["user:1".into()], None, b"a".to_vec());
        s.set("b", &["user:1".into()], None, b"b".to_vec());
        s.set("c", &["user:2".into()], None, b"c".to_vec());
        s.invalidate_tags(&["user:1".into()]); sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_none());
        assert!(s.get("c").is_some());
    }
    #[test] fn clear_empties() {
        let s = store();
        s.set("a", &["t".into()], None, b"a".to_vec());
        s.clear();
        assert!(s.get("a").is_none());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p brust-core page_cache 2>&1 | tail -5`
Expected: compile error (`PageCache` not found).

- [ ] **Step 3: Implement** (prepend above tests; copy the load-bearing comments from island_cache.rs verbatim — they document the ordering invariants)

```rust
//! L2 page cache: a string-keyed store of framed single-chunk response payloads
//! (`[meta_len: u16 BE][meta JSON][body]`), with tag-group invalidation. Mirrors
//! island_cache::MokaStore (set-before-index ordering, lazy expiry) but stores
//! opaque payload bytes. Process-global in the addon singleton; shared across
//! the worker pool. See spec 2026-06-11-page-cache-two-modes-design.md.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use moka::sync::Cache;
use parking_lot::Mutex;

#[derive(Clone)]
struct CachedPage {
    payload: Vec<u8>,
    expires_at: Option<Instant>,
}

impl CachedPage {
    fn is_expired(&self) -> bool {
        matches!(self.expires_at, Some(t) if Instant::now() >= t)
    }
}

pub struct PageCache {
    cache: Cache<String, CachedPage>,
    tag_index: Mutex<HashMap<String, HashSet<String>>>,
}

impl PageCache {
    pub fn new(max_capacity: u64) -> Self {
        Self {
            cache: Cache::new(max_capacity.max(1)),
            tag_index: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let v = self.cache.get(key)?;
        if v.is_expired() {
            self.cache.invalidate(key);
            return None;
        }
        Some(v.payload)
    }

    pub fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, payload: Vec<u8>) {
        let expires_at = ttl.map(|d| Instant::now() + d);
        // Index tags BEFORE the moka insert (panic-race tolerance; see island_cache).
        if !tags.is_empty() {
            let mut idx = self.tag_index.lock();
            for tag in tags {
                idx.entry(tag.clone()).or_default().insert(key.to_string());
            }
        }
        self.cache.insert(key.to_string(), CachedPage { payload, expires_at });
    }

    pub fn invalidate_key(&self, key: &str) {
        self.cache.invalidate(key);
    }

    pub fn invalidate_tags(&self, tags: &[String]) {
        let keys: Vec<String> = {
            let mut idx = self.tag_index.lock();
            tags.iter().filter_map(|t| idx.remove(t)).flatten().collect()
        };
        for k in keys {
            self.cache.invalidate(&k);
        }
    }

    pub fn clear(&self) {
        let mut idx = self.tag_index.lock();
        self.cache.invalidate_all();
        self.cache.run_pending_tasks();
        idx.clear();
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p brust-core page_cache 2>&1 | tail -8`
Expected: all 7 PASS.

- [ ] **Step 5: Lint + commit**

```bash
cargo fmt --all && cargo clippy -p brust-core --all-targets --locked -- -D warnings 2>&1 | tail -3
git add crates/brust-core/src/cache/page_cache.rs crates/brust-core/src/cache/mod.rs
git commit -m "feat(cache): L2 PageCache store with tag invalidation (page_cache.rs)"
```

---

## Task 3: extend `CacheKey` + `CacheConfig` (drop vary, add prefix/bypass)

**Files:**
- Modify: `crates/brust-core/src/cache/response_cache.rs`
- Modify: `crates/brust-core/src/server/mod.rs` (the `build_cache_key_sorts_query_and_uses_vary` test + `build_cache_key`/`lookup_vary_headers` call sites — done in Task 6; here only the struct + its own test helpers)

- [ ] **Step 1: Update `CacheConfig` + `CacheKey` + test helper**

Replace `CacheConfig` and `CacheKey` (response_cache.rs:9-22):

```rust
/// Per-request bypass: `true` ⇒ always route to L2; a string ⇒ a key-expression
/// whose non-empty result ⇒ route to L2. Untagged so JSON `true` / "expr" both
/// deserialize. (bool and string are disjoint JSON types — no ambiguity.)
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum BypassSpec {
    Always(bool),
    Expr(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct CacheConfig {
    pub ttl_seconds: u64,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub bypass: Option<BypassSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub prefix: String,
    pub method: String,
    pub path: String,
    pub sorted_query: String,
}
```

Update the test helper `key()` (response_cache.rs:185-192) to set `prefix: String::new()` and drop `vary_values`:

```rust
    fn key(method: &str, path: &str, query: &str) -> CacheKey {
        CacheKey {
            prefix: String::new(),
            method: method.to_string(),
            path: path.to_string(),
            sorted_query: query.to_string(),
        }
    }
```

- [ ] **Step 2: Add a collision test** (in response_cache.rs tests module)

```rust
    #[test]
    fn prefix_is_collision_free_field() {
        let a = CacheKey { prefix: "ten".into(), method: "GET".into(), path: "/ant".into(), sorted_query: String::new() };
        let b = CacheKey { prefix: "tenant".into(), method: "GET".into(), path: "".into(), sorted_query: String::new() };
        assert_ne!(a, b, "prefix is a distinct field, cannot collide with path");
    }
```

- [ ] **Step 3: Build (expect server/mod.rs breakage — fixed in Task 6)**

Run: `cargo build -p brust-core 2>&1 | rg "vary_values|\.vary|lookup_vary" | head`
Expected: errors only in `server/mod.rs` referencing the removed `vary`/`vary_values`. That's expected — Task 6 fixes them. The response_cache.rs unit tests should compile on their own:
Run: `cargo test -p brust-core response_cache:: 2>&1 | tail -6` (will fail to BUILD the crate due to server/mod.rs — acceptable; proceed to Task 6, then return here to confirm).

> Tasks 3 + 6 must land in one commit (the crate won't compile between them). Do NOT commit at the end of Task 3 alone — commit after Task 6.

**BLOCKED fallback:** if other call sites beyond server/mod.rs reference `vary_values` (run `rg "vary_values|lookup_vary_headers|\.vary\b" crates/brust-core/src`), fix each to the new shape. The only legitimate ones are in server/mod.rs (Task 6).

---

## Task 4: RouteConfig cache fields + compiled exprs + envelope.bypassed

**Files:**
- Modify: `crates/brust-core/src/routing/routes.rs`

First READ the file fully (`RouteConfig` ~206, `RouteTable` install/`cache_for`/`native_template_for` ~234-265, `RequestEnvelope` ~19-29, `build_request_envelope` ~317-379).

- [ ] **Step 1: Confirm RouteConfig.cache deserializes the new fields**

`RouteConfig.cache: Option<CacheConfig>` already exists; the new `prefix`/`bypass` come for free from Task 3's `CacheConfig`. No struct change unless `RouteConfig` re-declares cache fields. Verify with `rg "struct RouteConfig" -A8 crates/brust-core/src/routing/routes.rs`.

- [ ] **Step 2: Store compiled exprs in a parallel Vec on RouteTable**

In `RouteTable` (or whatever holds `cache_configs`), add a sibling field holding the compiled prefix/bypass per route_id. Add a struct:

```rust
use crate::cache::key_expr::Expr;
use crate::cache::response_cache::BypassSpec;

/// Compiled, request-ready cache directives for one route. Parsed once at
/// install (errors surface as install failure); evaluated per request.
#[derive(Clone, Default)]
pub struct CompiledCache {
    pub prefix: Option<Expr>,
    /// None = never bypass; Some(None) = always; Some(Some(expr)) = conditional.
    pub bypass: Option<Option<Expr>>,
}
```

In `install_with_config`, for each route's `cache`, compile:

```rust
let compiled = match &cfg.cache {
    Some(cc) => {
        let prefix = match &cc.prefix {
            Some(s) => Some(Expr::parse(s).map_err(|e| /* install error */ e)?),
            None => None,
        };
        let bypass = match &cc.bypass {
            None => None,
            Some(BypassSpec::Always(true)) => Some(None),
            Some(BypassSpec::Always(false)) => None,
            Some(BypassSpec::Expr(s)) => Some(Some(Expr::parse(s).map_err(|e| e)?)),
        };
        CompiledCache { prefix, bypass }
    }
    None => CompiledCache::default(),
};
// push into self.compiled_cache parallel to cache_configs
```

Add an accessor `pub fn compiled_cache_for(&self, route_id: u32) -> Option<&CompiledCache>`.

> Match the install fn's existing error type. If it returns `Result<u32, E>`, map `Expr::parse`'s `String` error into `E` (likely a `format!`-based variant or `anyhow`/`String`).

- [ ] **Step 3: Add `bypassed` to RequestEnvelope/the render envelope**

Add `pub bypassed: bool` to `RequestEnvelope` (default false) AND ensure it serializes into the JSON the worker receives. Find where the envelope is serialized to the SAB (search `serde_json::to_` / the dispatch payload build near `build_request_envelope`). Add `bypassed` to that JSON object so the worker's `RouteCall` can read it.

> If the envelope is serialized via a serde struct, `#[serde(default)] pub bypassed: bool` + set it true on the bypass path. If it's hand-built JSON, add `"bypassed": <bool>`.

- [ ] **Step 4: Build + add a parse-error install test**

```rust
#[test]
fn install_rejects_bad_prefix_expr() {
    // construct a RouteConfig with cache.prefix = "or(cookie(x)" and assert install errors
}
```

Run: `cargo test -p brust-core routing:: 2>&1 | tail -8` (will not link until Task 6; build-check the module compiles in isolation where possible).

- [ ] **Step 5:** (commit deferred to Task 6 — crate won't compile yet)

**BLOCKED fallback:** if the install fn signature makes threading a parse error awkward, have `install_with_config` collect the first `Expr::parse` error and return it as the existing error type via `.to_string()`. The key requirement: a malformed expression fails the boot loudly, not silently.

---

## Task 5: wire PageCache into AppState

**Files:**
- Modify: `crates/brust-core/src/config.rs`

READ config.rs around the `island_cache` field (~53-56) + delegation (~265-290) + `AppState::new`.

- [ ] **Step 1: Add the field + construction**

```rust
use crate::cache::page_cache::PageCache;
// in AppState struct:
pub(crate) page_cache: PageCache,
// in AppState::new(...), alongside island_cache construction:
page_cache: PageCache::new(1000),
```

- [ ] **Step 2: Add delegation methods** (mirror the island_cache delegations)

```rust
pub fn page_cache_get(&self, key: &str) -> Option<Vec<u8>> { self.page_cache.get(key) }
pub fn page_cache_set(&self, key: &str, tags: &[String], ttl: Option<Duration>, payload: Vec<u8>) {
    self.page_cache.set(key, tags, ttl, payload);
}
pub fn page_cache_invalidate_key(&self, key: &str) { self.page_cache.invalidate_key(key); }
pub fn page_cache_invalidate_tags(&self, tags: &[String]) { self.page_cache.invalidate_tags(tags); }
pub fn page_cache_clear(&self) { self.page_cache.clear(); }
```

- [ ] **Step 3: Build**

Run: `cargo build -p brust-core 2>&1 | rg "page_cache" | head`
Expected: no errors about page_cache (server/mod.rs vary errors from Task 3 may still show — fixed in Task 6).

- [ ] **Step 4:** (commit deferred to Task 6)

**BLOCKED fallback:** if `AppState::new` is large/has many call sites, only the field initializer line is needed; `Duration` import may already be present.

---

## Task 6: server — bypass/prefix eval, native writeback, set-cookie guard

**Files:**
- Modify: `crates/brust-core/src/server/mod.rs`

READ `handle_request` (~590-640), `build_cache_key` (~1535), `lookup_vary_headers` (~1599 — DELETE it), `dispatch_single_chunk` (signature + body ~1097, callers at ~616/737/SSE/WS), `dispatch_streaming` + `CacheWriteback` (~619-629, insert sites ~1303/1346/1367), `decode_fast_lane`/`response_from_meta` (~1162).

- [ ] **Step 1: Rewrite `build_cache_key` for prefix (drop vary)**

```rust
fn build_cache_key(method: &str, full_path: &str, prefix: String) -> CacheKey {
    let (path, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    CacheKey { prefix, method: method.to_string(), path: path.to_string(), sorted_query: sort_query(query) }
}
```

Delete `lookup_vary_headers`. (Keep `sort_query`.)

- [ ] **Step 2: Eval bypass + prefix in handle_request before lookup**

At the cache-decision site (~602-612), build an `EvalCtx` from the request's headers/cookies/query/params (the data is in `req`/the envelope). Then:

```rust
let compiled = routes.compiled_cache_for(route_id);
let cache_config = routes.cache_for(route_id);
let mut bypassed = false;
let cache_key = match (&cache_config, compiled) {
    (Some(cfg), Some(cc)) => {
        // bypass?
        let bypass_hit = match &cc.bypass {
            None => false,
            Some(None) => true,                       // always
            Some(Some(expr)) => !expr.eval(&ctx).is_empty(),
        };
        if bypass_hit {
            bypassed = true;
            None                                       // skip L1 read AND write
        } else {
            let prefix = cc.prefix.as_ref().map(|e| e.eval(&ctx)).unwrap_or_default();
            Some(build_cache_key(&method, &path, prefix))
        }
    }
    _ => None,
};
if let Some(key) = &cache_key {
    if let Some(bytes) = cache.get(key) {
        return Ok(body::response_from_framed_bytes(bytes));
    }
}
```

Set `envelope.bypassed = bypassed;` before dispatch.

> Build `EvalCtx` borrowing from `req.headers()` (as `(&str,&str)` pairs), parsed cookies, query pairs, and matched params. If params aren't readily available at this site, pass `&[]` for params (path-param keying is a nice-to-have; document if deferred). `cookie()` MUST scan all Cookie headers — reuse the cookie parse from `build_request_envelope`.

- [ ] **Step 3: Give native routes a writeback**

Add `writeback: Option<CacheWriteback>` param to `dispatch_single_chunk`. At the native render caller (~616), pass:

```rust
let writeback = match (&cache_key, &cache_config) {
    (Some(key), Some(cfg)) => Some(CacheWriteback { cache: cache.clone(), key: key.clone(), ttl: Duration::from_secs(cfg.ttl_seconds) }),
    _ => None,
};
return Ok(dispatch_single_chunk(&pool, envelope, "render", writeback).await);
```

At ALL other `dispatch_single_chunk` callers (action ~737, SSE, WS, mcp), pass `None`. After the fast-lane decode (`decode_fast_lane`→meta), if `writeback` is Some AND the response is single-chunk AND meta headers do NOT contain `set-cookie`, `cache.insert(key, framed_bytes, ttl)`.

- [ ] **Step 4: Set-Cookie guard on the React path too**

At the `dispatch_streaming` insert sites (~1303/1346/1367), guard the insert: skip if the response meta headers contain a `set-cookie` (case-insensitive) entry; `tracing::warn!` once.

- [ ] **Step 5: Rewrite the vary test → prefix**

Replace `build_cache_key_sorts_query_and_uses_vary` (~1661) with:

```rust
#[test]
fn build_cache_key_sorts_query_and_applies_prefix() {
    let k = build_cache_key("GET", "/p?b=2&a=1", "tenant-acme".to_string());
    assert_eq!(k.prefix, "tenant-acme");
    assert_eq!(k.path, "/p");
    assert_eq!(k.sorted_query, "a=1&b=2"); // match sort_query's actual format
}
```

- [ ] **Step 6: Build + test + commit (Tasks 3-6 together)**

```bash
cargo build --workspace --locked 2>&1 | tail -5
cargo test -p brust-core 2>&1 | tail -8     # response_cache, page_cache, key_expr, routing, server all green
cargo fmt --all && cargo clippy --workspace --all-targets --locked -- -D warnings 2>&1 | tail -3
git add crates/brust-core
git commit -m "feat(cache): L1 prefix/bypass eval, native-route writeback, set-cookie guard, drop vary"
```

Expected: full brust-core suite green.

**BLOCKED fallback:** if `cache` isn't `Clone`/`Arc` at the single-chunk caller, check how `dispatch_streaming`'s `CacheWriteback` obtains its `cache` handle (~619) and mirror exactly. If params aren't available at the eval site, ship with `params: &[]` and note `param()` is a follow-up (don't block the whole feature on path-param keying).

---

## Task 7: napi page_cache bindings

**Files:**
- Modify: `crates/brust/src/lib.rs` (after the island_cache bindings ~509)

- [ ] **Step 1: Add bindings** (mirror island_cache_* exactly; Buffer in/out)

```rust
#[napi]
pub fn page_cache_get(key: String) -> Option<napi::bindgen_prelude::Buffer> {
    state().page_cache_get(&key).map(|v| v.into())
}

#[napi]
pub fn page_cache_set(key: String, tags: Vec<String>, ttl_ms: Option<u32>, payload: napi::bindgen_prelude::Buffer) {
    let ttl = ttl_ms.map(|ms| std::time::Duration::from_millis(ms as u64));
    state().page_cache_set(&key, &tags, ttl, payload.to_vec());
}

#[napi]
pub fn page_cache_invalidate(key: Option<String>, tags: Option<Vec<String>>) {
    let s = state();
    if let Some(k) = key { s.page_cache_invalidate_key(&k); }
    if let Some(t) = tags { s.page_cache_invalidate_tags(&t); }
}

#[napi]
pub fn page_cache_clear() {
    state().page_cache_clear();
}
```

- [ ] **Step 2: Build the addon**

```bash
cd runtime && bun run build:debug 2>&1 | tail -5 && cd ..
```
Expected: build succeeds; generated `runtime/index.d.ts` (or the napi binding `.d.ts`) now lists `pageCacheGet/Set/Invalidate/Clear`. Verify: `rg "pageCache" runtime/*.d.ts`.

- [ ] **Step 3: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --locked -- -D warnings 2>&1 | tail -3
git add crates/brust runtime/*.d.ts runtime/*.node 2>/dev/null; git add crates/brust
git commit -m "feat(cache): napi page_cache get/set/invalidate/clear bindings"
```

> `.node` is gitignored (per repo memory) — don't force-add it. The `.d.ts` may be gitignored too; only `git add` what `git status` shows as tracked/new-and-wanted.

**BLOCKED fallback:** if `Buffer` import path differs, `rg "Buffer" crates/brust/src/lib.rs` to match the existing import style used elsewhere in the file.

---

## Task 8: TS types — RouteCacheConfig, CacheKeyResult, remove native+cache guard, RouteCall.bypassed

**Files:**
- Modify: `runtime/routes.ts`

READ: `RouteCacheConfig` (~159), `Route` (~274), `BrustRequest` (~89), `FlatRoute` (~350), `validateRoute` native+cache guard (~424), `RouteCall` 'render' union (~568), `flattenRoutes`.

- [ ] **Step 1: Replace RouteCacheConfig + add CacheKeyResult**

```ts
export interface CacheKeyResult {
  key: string
  tags?: string[]
  ttl?: number // seconds; overrides key_ttl_seconds / ttl_seconds
}

export interface RouteCacheConfig<Params = Record<string, string>> {
  ttl_seconds: number
  /** L1 declarative key prefix expression (evaluated in Rust). */
  prefix?: string
  /** Route to L2 when truthy: a key-expression (conditional) or `true` (always). */
  bypass?: string | boolean
  /** L2 programmatic key (runs in the worker). Returns the COMPLETE key. */
  key?: (ctx: { req: BrustRequest; url: URL; params: Params }) => CacheKeyResult | Promise<CacheKeyResult>
  /** Static L2 TTL (seconds); CacheKeyResult.ttl overrides per-entry. */
  key_ttl_seconds?: number
}
```

Remove the `vary?: string[]` field. Update `Route.cache?: RouteCacheConfig` typing if it referenced params.

- [ ] **Step 2: Remove the native+cache rejection**

Delete the guard at validateRoute (~424) that throws `'native: true' cannot coexist with 'cache'`. Replace with the new warn:

```ts
if (route.cache?.key && route.cache.bypass === undefined) {
  console.warn(`[brust] route ${where}: cache.key has no cache.bypass — L2 is unreachable (bypass never routes to it)`)
}
```

- [ ] **Step 3: Add `bypassed` to the render RouteCall**

In the `RouteCall` 'render' union member (~568), add `bypassed?: boolean`.

- [ ] **Step 4: Typecheck**

Run: `bun run ci 2>&1 | tail -5` (biome) and `rg "vary" runtime/routes.ts` (expect 0).
Expected: biome clean; if there's a tsc gate (`bun run typecheck:treaty`), run it.

- [ ] **Step 5: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(cache): TS RouteCacheConfig (prefix/bypass/key), drop vary, remove native+cache guard"
```

**BLOCKED fallback:** if removing `vary` breaks the FlatRoute serialization typing, check `flattenRoutes` for a `.vary` read and remove it. If `BrustRequest` import isn't in scope for the type, it's already defined in the same file (~89) — reference directly.

---

## Task 9: index.ts — serialize prefix/bypass (strip key fn) + re-export bindings

**Files:**
- Modify: `runtime/index.ts`

READ: the `registerRoutes` serialization (~189) and the `cache` barrel exports (~999).

- [ ] **Step 1: Strip the `key` function before JSON.stringify**

The route serialization sends `cache` whole. The `key` function and `key_ttl_seconds` must NOT go to Rust. Build a Rust-safe cache projection:

```ts
const configs = routes.map((r) =>
  JSON.stringify({
    path: r.fullPath,
    cache: r.cache
      ? { ttl_seconds: r.cache.ttl_seconds, prefix: r.cache.prefix ?? null, bypass: r.cache.bypass ?? null }
      : null,
    nativeTemplate: r.nativeTemplate ?? null,
  }),
)
```

(`bypass` passes through as boolean `true`/`false` or the string expr — serde `BypassSpec` untagged handles both; `null`/`undefined` → `None`.)

- [ ] **Step 2: Verify pageCache bindings are reachable**

The napi bindings auto-export from the addon. Confirm `(native as any).pageCacheInvalidate` etc. resolve. No re-export needed unless `cache.ts` imports them by name.

- [ ] **Step 3: Build addon already done (Task 7). Typecheck + commit**

```bash
bun run ci 2>&1 | tail -3
git add runtime/index.ts
git commit -m "feat(cache): serialize prefix/bypass to Rust, strip L2 key fn from route config"
```

---

## Task 10: worker L2 capture/replay in makeRenderer

**Files:**
- Modify: `runtime/routes.ts` (the `makeRenderer`/render handler ~642-960)

This is the integration core. READ the render handler carefully first.

- [ ] **Step 1: Add the L2 hook around the render**

After the middleware chain runs and `flat` is resolved, before `buildRenderElement`/the native fast-lane:

```ts
const cc = flat.cache
const wantL2 = call.bypassed && typeof cc?.key === 'function'
let l2Key: CacheKeyResult | undefined
if (wantL2) {
  const url = new URL(call.req.url, 'http://internal')           // req.url is a string
  l2Key = await cc!.key!({ req: call.req, url, params: call.params ?? {} })
  const cached = (native as any).pageCacheGet?.(l2Key.key) as Buffer | null | undefined
  if (cached && cached.length > 0) {
    // REPLAY: write the framed payload into the SAB slot, return its length (fast lane)
    if (cached.length <= slotView.length) {
      slotView.set(cached, 0)
      return cached.length
    }
    // too large for slot → fall through to a fresh render (don't serve truncated)
  }
}
```

After the render branch computes its return `len` (the framed bytes are at `slotView[0..len]`), capture for L2 on a miss:

```ts
function maybeStoreL2(len: number): number {
  if (wantL2 && l2Key && len > 0 && len <= slotView.length) {
    const payload = slotView.subarray(0, len).slice() // copy out of the SAB
    if (!payloadHasSetCookie(payload)) {
      const ttlSec = l2Key.ttl ?? cc!.key_ttl_seconds ?? cc!.ttl_seconds
      ;(native as any).pageCacheSet?.(l2Key.key, l2Key.tags ?? [], Math.round(ttlSec * 1000), payload)
    }
  }
  return len
}
```

Wrap each native/React single-chunk `return <len>` in the render handler with `return maybeStoreL2(<len>)`. Add the meta-parse helper:

```ts
// payload = [meta_len: u16 BE][meta JSON][body]; detect a set-cookie header.
function payloadHasSetCookie(payload: Uint8Array): boolean {
  if (payload.length < 2) return false
  const metaLen = (payload[0] << 8) | payload[1]
  if (payload.length < 2 + metaLen) return false
  try {
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(2, 2 + metaLen)))
    const headers = (meta?.headers ?? {}) as Record<string, unknown>
    return Object.keys(headers).some((h) => h.toLowerCase() === 'set-cookie')
  } catch {
    return false
  }
}
```

> Native renders hardcode `headers: {}` so the guard is a no-op there; it matters for React L2. Streaming responses never reach this single-chunk path, so they're never L2-cached.

- [ ] **Step 2: Build (addon already built) + run native + integration tests**

```bash
bun test runtime/ 2>&1 | tail -8
bun test tests/native-island.test.ts tests/integration.test.ts 2>&1 | tail -8
```
Expected: green (run integration files separately if a port-race flake appears — known flake).

- [ ] **Step 3: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(cache): worker L2 capture/replay via SAB payload (page cache get/set)"
```

**BLOCKED fallback:** if there are too many `return <len>` exit points to wrap individually, refactor the render body into an inner `async function renderToSab(): Promise<number>` and wrap the single call site: `return maybeStoreL2(await renderToSab())`, with the early replay before it. If `call.params` doesn't exist on the render call, pass `{}` and note path-params in L2 ctx are a follow-up.

---

## Task 11: cache.ts — invalidate fan-out

**Files:**
- Modify: `runtime/cache.ts`

- [ ] **Step 1: Fan out to the page cache**

```ts
invalidate(args: InvalidateArgs): void {
  ;(native as any).islandCacheInvalidate?.(args.key, args.tags)
  ;(native as any).pageCacheInvalidate?.(args.key, args.tags)
},
```

- [ ] **Step 2: Test round-trip via the real addon** (`tests/` or a runtime test)

```ts
// set a payload with a tag, invalidate by tag, assert get → null
import * as native from '../runtime/index.js'
native.pageCacheSet('t:1', ['grp'], 60000, Buffer.from('X'))
expect(native.pageCacheGet('t:1')?.length).toBe(1)
native.pageCacheInvalidate(undefined, ['grp'])
expect(native.pageCacheGet('t:1')).toBeNull()
```

Run: `bun test <that file> 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add runtime/cache.ts tests/
git commit -m "feat(cache): cache.invalidate fans out to page cache (key + tags)"
```

---

## Task 12: full baseline + browser smoke + release-gate mirror

**Files:** none (verification)

- [ ] **Step 1: Rebuild addon + full Rust + full TS**

```bash
cd runtime && bun run build:debug && cd ..
cargo test --workspace --locked 2>&1 | tail -6
cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings 2>&1 | tail -3
bun run ci 2>&1 | tail -3
bun test runtime/ 2>&1 | tail -6
for f in native-island native-island-ssr cli-new integration; do bun test tests/$f.test.ts 2>&1 | tail -2; done
```
Expected: all green (cli-build /native-islands data-testid is a known pre-existing fail on main — not a regression).

- [ ] **Step 2: Browser smoke — native hybrid route** (build a throwaway example route or use an existing native route + a temp cache config)

Verify: anonymous request → L1 hit (0-Bun, confirm via repeat-timing or a cache stats probe); request with the `bypass` cookie → L2 path; `cache.invalidate({tags})` forces a fresh L2 render. Use Playwright with `Cache-Control: no-cache` to avoid browser-cache false signals (repo lesson).

- [ ] **Step 3: Commit any fixes; no commit if clean.**

---

## Task 13: docs page

**Files:**
- Create/Modify: `example/docs/content/caching.md` (+ nav entry if mdNav needs it)

- [ ] **Step 1: Write the caching docs** — cover: the single `cache` object; L1 (`prefix`/`bypass`, the grammar table, zero-Bun on native); L2 (`key` returning `{key,tags,ttl}`, runs in worker); the `bypass` router table (absent→L1, expr→hybrid, true→L2); invalidation (`cache.invalidate({key,tags})` covers islands + pages); the L1-skips-middleware caveat; `vary` removed → use `prefix`.

- [ ] **Step 2: Build docs to confirm md compiles**

```bash
cd example/docs && bun run build 2>&1 | tail -5 && cd ../..
```

- [ ] **Step 3: Commit**

```bash
git add example/docs
git commit -m "docs(cache): two-layer page cache page (L1/L2, bypass router, invalidation)"
```

---

## Self-Review

**Spec coverage:** Goal→T1-T11; L1 expr→T1; PageCache→T2; CacheKey.prefix/drop-vary→T3; compiled exprs+bypassed envelope→T4; AppState wiring→T5; bypass/prefix eval+native writeback+set-cookie guard→T6; napi→T7; TS types+guard removal→T8; serialize→T9; worker L2 capture/replay→T10; invalidate fan-out→T11; AC#8 baseline→T12; AC#9 docs→T13. Acceptance criteria 1-9 all mapped.

**Placeholder scan:** No TBD/TODO; every code step has concrete code or an exact signature + the file to mirror. The two "match the existing error type"/"build EvalCtx from req" notes are integration points where the exact local variable names must be read from the file — flagged with BLOCKED fallbacks, not left vague on behavior.

**Type consistency:** `Expr`/`EvalCtx` (T1) used in T4/T6; `BypassSpec`/`CacheConfig.prefix/bypass` (T3) used in T4/T9; `CompiledCache` (T4) used in T6; `PageCache` methods (T2) used in T5; `page_cache_*` AppState (T5) used in T7; `pageCacheGet/Set/Invalidate` (T7) used in T10/T11; `CacheKeyResult` (T8) used in T10. `key_ttl_seconds`/`ttl`/`ttl_seconds` precedence consistent T8↔T10.

**Ordering note:** Tasks 3+4+5+6 do not individually compile (the crate is broken mid-sequence by the vary removal); they land in ONE commit at the end of Task 6. Tasks 1, 2, 7-13 each compile + commit independently.
