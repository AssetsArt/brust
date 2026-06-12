# Decode Path Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Path params reach every consumer percent-decoded (full decode incl. `%2F`; `+` literal; per-VALUE raw fallback on malformed/invalid-UTF-8), decoded once at the Rust envelope production sites. BREAKING.

**Architecture:** One `decode_path_param` helper in routes.rs; applied in `match_path` (render/navigation) and the action router; envelope param values change `&'a str` → `Cow<'a, str>`; EvalCtx mapping becomes `v.as_ref()` so L1 `param()` inherits automatically; TS is pure passthrough (zero TS logic change); tests + docs flip. Spec: `docs/superpowers/specs/2026-06-12-decode-params-design.md` (read it first — the per-VALUE fallback rule is load-bearing).

**Tech Stack:** Rust (brust-core; `percent-encoding` 2.3.2 already in Cargo.lock via `url`), bun:test for e2e/integration.

**Ground rules (repo-specific):**
- After ANY Rust change: `cd runtime && bun run build` or later bun tests silently use the stale `.node`.
- Cargo gates: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- TS gate `bun run ci` (biome). NEVER bare tsc. Run from repo root.

---

### Task 1: Rust — decoder + envelope decode + EvalCtx inherit

**Files:**
- Modify: `crates/brust-core/Cargo.toml` (add dep)
- Modify: `crates/brust-core/src/routing/routes.rs` (decoder + match_path + RouteEnvelope/ActionEnvelope/build_action_envelope types + unit tests)
- Modify: `crates/brust-core/src/routing/action.rs:133` (decode action captures)
- Modify: `crates/brust-core/src/server/mod.rs` (~:691 EvalCtx `v.as_ref()`; ~:854-857 Cow adjust)
- Modify: `crates/brust-core/src/cache/key_expr.rs:8-12` (doc comment EXTEND only)

- [ ] **Step 1: Add the dependency** — in `crates/brust-core/Cargo.toml` under `[dependencies]`:

```toml
percent-encoding  = "2.3"
```

(Already resolved at 2.3.2 in Cargo.lock via `url` — no version bump ripples.)

- [ ] **Step 2: Write the failing unit tests** in routes.rs's existing `#[cfg(test)]` module (find it; `url_decode` tests live there — put these alongside):

```rust
    #[test]
    fn decode_path_param_basic_and_multibyte() {
        use std::borrow::Cow;
        assert_eq!(decode_path_param("sa%20wad-dee"), "sa wad-dee");
        // Thai: %E0%B8%AA%E0%B8%A7%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B5 = สวัสดี
        assert_eq!(
            decode_path_param("%E0%B8%AA%E0%B8%A7%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B5"),
            "สวัสดี"
        );
        assert_eq!(decode_path_param("a%2Fb"), "a/b"); // full decode incl. %2F
        assert_eq!(decode_path_param("a+b"), "a+b"); // + is literal in paths
        // no-% fast path: byte-identical AND borrowed (zero alloc)
        assert!(matches!(decode_path_param("plain-slug"), Cow::Borrowed("plain-slug")));
    }

    #[test]
    fn decode_path_param_per_value_raw_fallback() {
        use std::borrow::Cow;
        // Malformed % → WHOLE value raw (pre-validation), mirroring
        // decodeURIComponent's per-value throw — NOT the crate's per-sequence
        // behavior (a%ZZ%41 must NOT become a%ZZA).
        assert!(matches!(decode_path_param("a%ZZ%41"), Cow::Borrowed("a%ZZ%41")));
        assert!(matches!(decode_path_param("100%"), Cow::Borrowed("100%")));
        assert!(matches!(decode_path_param("%Z"), Cow::Borrowed("%Z")));
        // Valid hex but invalid UTF-8 → WHOLE value raw.
        assert!(matches!(decode_path_param("%FF%41"), Cow::Borrowed("%FF%41")));
        // CESU-8 lone surrogate → raw (decode_utf8 rejects).
        assert!(matches!(decode_path_param("%ED%A0%80"), Cow::Borrowed("%ED%A0%80")));
    }

    #[test]
    fn match_path_params_arrive_decoded_incl_catch_all() {
        let table = RouteTable::default();
        table
            .install(vec![
                RouteConfig { path: "/post/{slug}".into(), cache: None, native_template: None },
                RouteConfig { path: "/files/{*rest}".into(), cache: None, native_template: None },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/post/sa%20wad-dee", &headers) {
            MatchResult::Matched { envelope, .. } => {
                assert_eq!(envelope.params[0].1.as_ref(), "sa wad-dee");
            }
            _ => panic!("no match"),
        }
        // catch-all: %2F decodes inside the capture — indistinguishable from
        // real separators (spec decision; routing already happened).
        match table.match_path("GET", "/files/a%2Fb/c", &headers) {
            MatchResult::Matched { envelope, .. } => {
                assert_eq!(envelope.params[0].1.as_ref(), "a/b/c");
            }
            _ => panic!("no match"),
        }
    }
```

ADAPT to the file's actual test-module idioms: `RouteTable::install` signature and `RouteConfig` construction — read the existing route-table tests in the same module and mirror them exactly (if install takes a different shape, keep the SAME two patterns `/post/{slug}` + `/files/{*rest}` and the same assertions).

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p brust-core decode_path_param`
Expected: compile error (`decode_path_param` not found)

- [ ] **Step 4: Implement the decoder** in routes.rs next to `url_decode` (~:453):

```rust
/// Percent-decode ONE matched path-param value (spec:
/// docs/superpowers/specs/2026-06-12-decode-params-design.md).
/// Full RFC-3986 decode including `%2F`; `+` stays literal (space-as-plus is
/// a query convention — url_decode above is NOT reusable here). Fallback is
/// per-VALUE: any malformed `%` sequence or invalid post-decode UTF-8 returns
/// the WHOLE raw capture, mirroring the client matchFallback's
/// `try { decodeURIComponent } catch { raw }` so server and client always
/// produce the same value. (percent_decode_str alone decodes per-SEQUENCE on
/// malformed input — hence the explicit pre-validation scan.)
pub(crate) fn decode_path_param(raw: &str) -> std::borrow::Cow<'_, str> {
    // Fast path + pre-validation in one scan: every '%' must be followed by
    // two hex digits, else the whole value ships raw.
    let bytes = raw.as_bytes();
    let mut has_pct = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            has_pct = true;
            if i + 2 >= bytes.len() + 0
                || i + 2 > bytes.len() - 1
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return std::borrow::Cow::Borrowed(raw);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    if !has_pct {
        return std::borrow::Cow::Borrowed(raw);
    }
    match percent_encoding::percent_decode_str(raw).decode_utf8() {
        Ok(decoded) => decoded,
        Err(_) => std::borrow::Cow::Borrowed(raw),
    }
}
```

NOTE the bounds check: write it cleanly as `if i + 2 >= bytes.len() || !bytes[i+1].is_ascii_hexdigit() || !bytes[i+2].is_ascii_hexdigit()` — the expression above shows intent; simplify to exactly:

```rust
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return std::borrow::Cow::Borrowed(raw);
            }
```

Wait — `i + 2 >= bytes.len()` rejects a trailing valid `%41` at the END of the string (i+2 == len-1 is the last index; valid needs i+2 <= len-1, i.e. reject when i+2 > len-1 ⇔ i+2 >= len). `i + 2 >= bytes.len()` is CORRECT (when i+2 == len there is no bytes[i+2]). Keep it; the test `decode_path_param("a%2Fb")` (percent mid-string) and `"100%"` (trailing) pin both sides. Also `decode_utf8()` returns `Cow<'_, str>` borrowed from `raw` when the decode output equals input bytes — but we only reach it when a valid `%XX` exists, so it's always Owned in practice; either way returning it directly is correct.

- [ ] **Step 5: Wire the decode + type changes**

(a) `RouteEnvelope.params` (routes.rs:52) and `ActionEnvelope.params` (routes.rs:77):

```rust
    pub params: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
```

(b) `build_action_envelope`'s `params` parameter (routes.rs:193): same type.

(c) `match_path` (routes.rs:349-351):

```rust
                let mut params = Vec::new();
                for (k, v) in matched.params.iter() {
                    // Decode at the production site — loaders, clientLoader,
                    // L1 param() key expressions, x-props, native ctx, and
                    // treaty all consume THIS vec (directly or serialized),
                    // so one decode keeps every consumer consistent.
                    params.push((
                        std::borrow::Cow::Owned(k.to_string()),
                        decode_path_param(v),
                    ));
                }
```

(d) `crates/brust-core/src/routing/action.rs:133` — change the captures map:

```rust
                params: m
                    .params
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.to_string(),
                            crate::routing::routes::decode_path_param(v).into_owned(),
                        )
                    })
                    .collect(),
```

(adapt to the file's actual expression shape at :133 — the essential change is wrapping `v` with `decode_path_param(..).into_owned()`).

(e) `server/mod.rs` ~:688-702 EvalCtx mapping: `(k.as_ref(), *v)` → `(k.as_ref(), v.as_ref())`.

(f) `server/mod.rs` ~:854-857 action envelope assembly: the `&str` values become `Cow::Borrowed(v.as_str())` (compiler-guided; values in `owned_params` are already-decoded Strings — do NOT decode again here).

(g) `key_expr.rs:8-12` — EXTEND the NOTE:

```rust
/// NOTE: header/cookie/query values are passed through verbatim — NOT
/// percent-decoded. An `eq(cookie(x), "/")` will not match a `%2F`-encoded
/// value. The L1 sorted_query path is likewise undecoded, so key-building stays
/// internally consistent. PATH PARAMS are the exception: `param()` values
/// arrive percent-DECODED (decoded once at envelope production in
/// routing/routes.rs::decode_path_param — same values the loaders see).
```

- [ ] **Step 6: Run the Rust gates**

```bash
cargo test -p brust-core 2>&1 | grep -E "test result|FAILED" | head -5
cargo fmt --all
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings 2>&1 | tail -3
```

Expected: all green. Compiler will surface any `.params` consumer missed by the type change — fix mechanically (`as_ref()`/`into_owned()`), they are all internal.

- [ ] **Step 7: MANDATORY napi rebuild + TS suite sanity**

```bash
cd runtime && bun run build && cd ..
bun test runtime/ 2>&1 | tail -3
```

Expected: rebuild succeeds; runtime suite green EXCEPT any test asserting encoded params (none known in runtime/ — ssg flip is Task 2; if something fails on an encoded-param expectation, that IS the breaking flip — report it, do not "fix" the implementation).

- [ ] **Step 8: Commit**

```bash
git add crates/ && git commit -m "feat(params)!: percent-decode path params at envelope production (BREAKING)"
```

---

### Task 2: ssg test flip + %25 round-trip pin + encoded-assertion sweep

**Files:**
- Modify: `runtime/cli/ssg.test.ts` (~:414-418 flip; expansion unit area for the `%` pin)

- [ ] **Step 1: Flip the e2e assertion** — at ssg.test.ts:414-418 replace:

```ts
    // NOTE: Rust matchit does NOT decode params before the loader sees them —
    // the loader receives the percent-encoded form ('sa%20wad-dee', not 'sa wad-dee').
    // This is a known framework gap: params.slug is URL-encoded at SSG crawl time.
    expect(html).toContain('post:sa%20wad-dee') // encoded — see discrepancy note above
```

with:

```ts
    // Params arrive percent-DECODED framework-wide (decoded once at the Rust
    // envelope; same value in loaders, param() cache keys, and the client).
    expect(html).toContain('post:sa wad-dee')
```

- [ ] **Step 2: `%` round-trip pin** — find the `expandDynamicRoutes` unit tests in ssg.test.ts (the crawler `encodeURIComponent`s expansion values at runtime/cli/ssg.ts:219). Add ONE assertion to an existing expansion test (or a tiny new unit test next to them — NO new server boot):

```ts
test('expansion percent-encodes literal % in user-supplied param values', async () => {
  const expanded = await expandDynamicRoutes([
    {
      fullPath: '/post/{slug}',
      chain: [{ ssg: { params: () => [{ slug: '50%' }] } }],
    },
  ])
  expect(collectStaticPaths(expanded)).toContain('/post/50%25')
})
```

(ADAPT to the helpers' real signatures/import names used by the neighboring tests — mirror them exactly. The point pinned: literal `%` in a user value crawls as `%25` so the loader sees `50%` after decode.)

- [ ] **Step 3: Encoded-assertion sweep** (the breaking flip must be complete):

```bash
grep -rn "%20\|%E0\|%2F" runtime/ tests/ --include="*.ts" | grep -i "expect\|toContain\|toBe" | grep -v node_modules
grep -rn "%20" crates/ --include="*.rs" | grep -i "assert" | head
```

Rust `static_assets.rs` `%20` tests cover a DIFFERENT decoder — must NOT change. Report every hit and whether it needed flipping.

- [ ] **Step 4: Run + commit**

```bash
bun test runtime/cli/ssg.test.ts 2>&1 | tail -3   # slow, boots fixture dist — be patient
bun run ci
git add runtime/cli/ssg.test.ts && git commit -m "test(params)!: ssg loader sees decoded params + %25 round-trip pin"
```

Expected: 37+ pass 0 fail (was 36 + the new pin). If the flipped assertion FAILS with the encoded form still present: Task 1's binary is stale — re-run `cd runtime && bun run build` (known trap) before debugging anything else.

---

### Task 3: integration coverage — live decode (render, navigation, action)

**Files:**
- Modify: `tests/integration.test.ts`

The fixture already has `/blog/{slug}` whose loader echoes `Post: ${params.slug}` (tests/fixtures/app/routes.tsx:123-124). Follow the suite's `sharedPort()` conventions (see the `generator:` tests added recently for the exact shape).

- [ ] **Step 1: Add the tests**

```ts
test('params: loader receives percent-decoded values (space + Thai)', async () => {
  const port = sharedPort()
  const cases: Array<[string, string]> = [
    ['/blog/sa%20wad-dee', 'Post: sa wad-dee'],
    // สวัสดี — what a browser sends for /blog/สวัสดี
    ['/blog/%E0%B8%AA%E0%B8%A7%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B5', 'Post: สวัสดี'],
  ]
  for (const [p, expected] of cases) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(expected)
  }
})

test('params: SPA navigation payload sees decoded values too', async () => {
  const port = sharedPort()
  const res = await fetch(`http://127.0.0.1:${port}/_brust/page/blog/sa%20wad-dee`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('Post: sa wad-dee')
})
```

(ADAPT: if `/_brust/page` payload shape doesn't embed the title text directly, assert on whatever loader-derived field the payload carries — read one existing `/_brust/page` test in the suite first. If the fixture has a param-bearing ACTION route, add the same decoded assertion for it; if it does NOT, note the gap in the commit message — Rust action-router unit coverage from Task 1 stands.)

- [ ] **Step 2: Run + commit**

```bash
bun test tests/integration.test.ts 2>&1 | tail -3
bun run ci
git add tests/integration.test.ts && git commit -m "test(params): live decode coverage — render + SPA navigation"
```

Expected: 90+ pass 0 fail (88 baseline + 2).

---

### Task 4: docs

**Files:**
- Modify: `example/docs/content/static-export.md` (~:72-76)
- Modify: `example/docs/content/caching.md` (~:176-177)
- Modify: `example/docs/content/routing.md` (dynamic segments section)

Read each file's surrounding voice first; NEVER use the string "nextjs" anywhere.

- [ ] **Step 1: static-export.md** — REMOVE the whole sharp-edge paragraph (lines ~72-76, "One sharp edge … Plain URL-safe slugs are unaffected.") and replace with:

```md
Param values arrive **percent-decoded** in your loader — at build-crawl time
and live. A slug like `sa wad-dee` (or any Thai/Unicode slug) round-trips
as-is: the crawler encodes it into the URL, the router decodes it back before
your loader runs. No `decodeURIComponent` needed.
```

- [ ] **Step 2: caching.md** — update the verbatim note (~:176-177) to:

```md
Expression values are matched **verbatim** for headers, cookies, and query —
they are not percent-decoded. Path params are the exception: `param(name)`
values arrive **decoded**, the same values your loader sees.
```

- [ ] **Step 3: routing.md** — in the dynamic-segments section (the part documenting `{slug}` / `{*rest}`), add:

```md
Param values are **percent-decoded** before they reach your loader (and the
`param()` cache-key accessor): `/post/sa%20wad-dee` gives `params.slug ===
'sa wad-dee'`, and Thai/Unicode slugs arrive as the original characters. The
decode is full — an encoded `%2F` becomes a literal `/` **inside the value**
(route matching itself happens before decoding, so it cannot change which
route matches), and `+` stays a literal `+` (space-as-plus is a query-string
convention, not a path one). Catch-all (`{*rest}`) captures decode the same
way. If you previously worked around encoded params with
`decodeURIComponent(params.x)`, remove it — double-decoding corrupts values
containing a literal `%`.
```

- [ ] **Step 4: Verify + commit**

```bash
bun run docs:build   # expected: 20 pages + 20 spa payloads
bun run ci
git add example/docs/content/ && git commit -m "docs(params)!: params arrive decoded — remove workaround, document policy"
```

---

## BLOCKED fallbacks

- **Task 1 type ripple**: if changing the envelope param type cascades into more sites than listed, follow the compiler — every consumer is internal to brust-core (verified by spec review: routes.rs:350, server/mod.rs:689, action.rs:134, key_expr via slice). If a consumer NEEDS `&str` lifetimes (borrow from full_path), do NOT revert the decode — convert that consumer to `as_ref()`.
- **Task 2 flip still shows encoded**: stale napi binary (rebuild runtime/*.node) is the FIRST suspect, not the Rust logic — known trap, it has lied before.
- **Task 3 `/_brust/page` payload doesn't carry the title**: assert on the payload's loader-data JSON instead; if neither works, drop the navigation test to Rust-level (Task 1 covers the match_path call site) and report the gap honestly.
- **Anything suggesting route MATCHING changed** (404s appearing): that's a real regression — decode must happen strictly after `router.at`; stop and re-check, do not adjust tests.

## Self-review (plan-write time)

- Spec coverage: decoder+policy(per-VALUE, +literal, %2F, wildcard)→T1; EvalCtx/param() inherit→T1(e,g); action→T1(d,f); ssg flip+%25 pin→T2; sweep→T2; live render/navigation/Thai→T3; docs three files→T4; BREAKING release-note text lives in the spec §BREAKING (PR description copies it).
- Placeholders: none; all code complete with explicit ADAPT notes bounded to mirroring existing idioms.
- Type consistency: `decode_path_param` name used in T1 code, key_expr comment, and action.rs call; `Vec<(Cow, Cow)>` in all three struct/site mentions.
