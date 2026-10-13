# Docs site: Caching page — cache-key prefix, the full expression grammar, and complex examples

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · branch: docs-site (direct merge, no PR)

## Why

The human (2026-10-13) asked for complex `prefix` examples on /docs/caching. The page lists only part of the
grammar (no `param`, `request`, `env`, no `eq` 3-arg form) and has no example that splits the cache.

Source of truth: `crates/brust-core/src/cache/key_expr.rs` (grammar + eval), `crates/brust-core/src/cache/mod.rs:93`
(`build_cache_key`), `crates/brust-core/src/l2.rs:41` (key parts: prefix, method, path, sorted query).
Lead verified on a running server (2026-10-13): `?a=1` and `?a=2` are different entries; `?b=9&a=1` then `?a=1&b=9` → HIT.

## Rulings (final)

- **P1. New section "Split the cache with prefix"** (id `prefix`, in the TOC after `key`). The key is prefix +
  method + path + sorted query; the prefix is evaluated per request, `""` is a valid (shared) prefix.
- **P2. Grammar reference table**, every function from `key_expr.rs`, each with what it returns:
  `header(n)`, `cookie(n)`, `query(n)` (raw, not percent-decoded), `param(n)` (decoded), `request(host|method|scheme|path)`,
  `env(NAME)` (read once when the route is installed; refused on Cloudflare Workers), `'literal'` / bare word,
  `or(...)` (first non-empty), `and(...)` (all non-empty → joined by U+001F, else `""`), `concat(...)`,
  `eq(a, b)` (a when equal, else `""`), `eq(a, b, v)` (v when equal), `lower`, `upper`; `uuid()`/`timestamp()` are
  rejected at build. Header/cookie/query names match case-insensitively. Cite file:line in a `source:` comment.
- **P3. At least five complex examples**, each a route `cache` block + one sentence on what it splits and why:
  1. language: `lower(or(query(lang), cookie(lang), 'en'))`
  2. multi-tenant: `concat(request(host), '|', lower(or(cookie(lang), 'en')))`
  3. bounded A/B bucket: `concat('ab:', or(eq(cookie(ab), 'b', 'b'), 'a'))` — any other cookie value lands in `a`
  4. plan tier + bypass for signed-in users: `bypass: 'cookie(session)'`, `prefix: "or(eq(cookie(plan), 'pro', 'pro'), 'free')"`
  5. device class: `or(eq(header(sec-ch-ua-mobile), '?1', 'mobile'), 'desktop')`
  6. (optional) per-deploy: `concat(env(BUILD_ID), ':', param(name))`.
  Every example is **run for real**: a fixture app under the test dir (or a temp dir that is deleted) with those
  routes, `brust start`, and curl showing MISS/HIT per variant; the recorded transcript goes on the page as a
  code block (captured, not typed). Example 4 must show a signed-in request is `BYPASS` (whatever header value the
  server really sends — record it).
- **P4. Pitfalls box:** an unbounded value (raw `accept-language`, `user-agent`, a user id) makes one entry per value
  → normalise to a small set with `eq`/`or`; values are not decoded; a page with per-user data needs `bypass`, not a prefix.
- **P5. Interactive key playground (client-only, works in the static export):** pick a preset expression or type one,
  set request fields (path, query, a few cookies/headers, host), see the evaluated prefix and the resulting key parts,
  or the parse error. A TS port of the parser/evaluator in `website/lib/cache-key.ts`, with a header comment naming
  key_expr.rs. `test/lib.test.ts` (or a new test) runs the Rust test vectors from `key_expr.rs` against the TS port,
  and cross-checks at least the six examples against the real server's HIT/MISS. Label: "the same rules as the
  server, evaluated in your browser". Assert the playground's tier in the build test.
- **P6.** The existing one-line grammar sentence on the page is replaced by a link to the new section. The
  `docs-static-export` lane also edits `Caching.tsx` (CacheProbe region): do not touch CacheProbe; whichever lane
  merges second rebases. Gates as usual (typecheck, bun test, build, screenshots light/dark/400px).
