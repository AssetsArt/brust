# Decode path params framework-wide — design

**Date:** 2026-06-12 · **Status:** approved scope (user-ordered handoff from 0.1.47-alpha) · **BREAKING**

## Goal

Path params reach every consumer percent-DECODED. Today matchit's raw captures
ship verbatim (`sa%20wad-dee`, Thai slugs → `%E0%B8…`) into loaders, native
loader ctx, components, L2 `cache.key`, Rust L1 `param()` key expressions, and
SSG crawl loaders — every Thai-language slug needs a `decodeURIComponent`
workaround. Decode ONCE at the Rust envelope production sites so every consumer
(server and client) sees the same decoded value, matching what Next.js/Remix/
every mainstream router does.

## Non-goals

- Header/cookie/query **key-expression** values stay verbatim (documented
  EvalCtx semantics — only `param()` changes).
- `RequestEnvelope.search` is ALREADY decoded (`url_decode`, routes.rs:425-439)
  — unchanged.
- L1 `CacheKey.path` / `sorted_query` stay raw `full_path` bytes
  (byte-reproducibility) — unchanged, and unaffected by this change
  (server/mod.rs:1705-1716 never touches `envelope.params`).
- SSE/WS/MCP envelopes carry no params — unchanged.
- No new route-matching semantics: matchit matches the RAW path BEFORE any
  decode, exactly as today. Decoding cannot change which route matches.

## Decision: decode policy

**Full RFC-3986 percent-decode of each captured param value, including `%2F`,
with two rules:**

1. **`+` is NOT converted to space.** `+` is a literal character in path
   segments (space-as-plus is a query-string convention). The existing
   `url_decode` (used for query strings) converts `+`→space and is therefore
   NOT reusable for params.
2. **Invalid input → the WHOLE value ships raw (per-VALUE fallback).** The
   decoder pre-validates that every `%` is followed by two hex digits; on any
   malformed sequence (`%ZZ`, lone trailing `%`) OR when the decoded bytes are
   not valid UTF-8 (`%FF`, CESU-8 lone surrogates like `%ED%A0%80`), the param
   ships as the raw matched text byte-for-byte — `a%ZZ%41` stays `a%ZZ%41`
   (the valid `%41` does NOT decode). This deliberately mirrors
   `decodeURIComponent`'s per-value throw semantics so the client fallback
   matcher (`try { decodeURIComponent } catch { raw }`,
   runtime/islands/fallback.ts:47-53) and the server produce the SAME value in
   BOTH failure modes. NOTE: this is stricter than the raw
   `percent_decode_str(..).decode_utf8()` behavior, which decodes per-SEQUENCE
   on malformed `%` (`a%ZZ%41` → `a%ZZA`) — hence the explicit pre-validation
   scan before calling the crate decoder.

3. **Catch-all captures decode the same way.** Wildcard routes
   (`'/files/{*rest}'`, documented in routing.md) flow through the same
   production site; `/files/a%2Fb/c` captures `a%2Fb/c` → decodes to `a/b/c`,
   indistinguishable from three real segments — consistent with the
   full-decode policy and stated in the docs. (The client `matchFallback` does
   fixed-segment matching and cannot match catch-alls — pre-existing,
   unchanged, and not implied by the consistency claim above.)

**Why full decode (the `%2F` question, resolved from code):** the framework
already HAS one param decoder in production — the SSG fallback client takeover
`matchFallback` — and it fully decodes via `decodeURIComponent`, including
`%2F`. Keeping `%2F` encoded server-side would make the same route's loader see
`a%2Fb` on the server and `a/b` in the client takeover. A decode-except-`%2F`
scheme also introduces `%252F`-vs-`%2F` collision ambiguity. Routing is decided
before decode, so a decoded `/` cannot traverse into a different route; a
param value containing `/` is the app's data. Documented consequence.

## Implementation

### Rust (single production layer)

| Site | Change |
|---|---|
| `crates/brust-core/src/routing/routes.rs:349-351` (`match_path`) | decode each `v`; `RouteEnvelope.params` + `ActionEnvelope.params` type → `Vec<(Cow<'a, str>, Cow<'a, str>)>` (values were `&'a str` borrowed from `full_path`; decoded values are owned) |
| `crates/brust-core/src/routing/action.rs:133` (action router match) | decode each `v.to_string()` → decoded owned String (already owned — no lifetime change) |
| `crates/brust-core/src/server/mod.rs:688-702` (EvalCtx) | mechanical: `(k.as_ref(), *v)` → `(k.as_ref(), v.as_ref())`; key_expr `param()` then sees decoded values automatically — NO logic change in key_expr.rs; EXTEND its doc comment (key_expr.rs:8-12, currently covers header/cookie/query verbatim semantics and does not mention params) with "path params ARE percent-decoded; header/cookie/query stay verbatim" |
| `crates/brust-core/src/server/mod.rs:854-857` (action envelope assembly) | follows the action.rs decode; type-level Cow adjustment only |
| `crates/brust-core/src/routing/routes.rs:189-213` (`build_action_envelope`) | its `params` parameter type changes with the ActionEnvelope field (`Vec<(Cow, Cow)>`) |
| decoder | new `pub(crate) fn decode_path_param(&str) -> Cow<str>` in routes.rs next to `url_decode` (action.rs calls it too): pre-validate every `%` has 2 hex digits (else return `Cow::Borrowed(raw)` — per-VALUE), then `percent_decode_str(..).decode_utf8()`; `Err` (invalid UTF-8) → `Cow::Borrowed(raw)`. Percent-only — no `+`→space. `percent-encoding` already in Cargo.lock 2.3.2 via `url`; add as a direct dependency of brust-core. Verified: the crate returns `Cow::Borrowed` when nothing decodes — a no-`%` value is zero-alloc (common ASCII-slug case) |

The three existing hand-rolled decoders (`url_decode`, `percent_decode`,
`percent_decode_path`) are NOT consolidated in this change (different
semantics each; out of scope).

### TS — zero behavioral code, contract only

Loaders, native ctx, components, L2 `cache.key`, `wantsSsgFallbackShell`
(sentinel `__brust_fallback__` contains no `%` — compare unaffected),
navigation chain loaders, treaty: all read `call.params` passthrough and now
receive decoded values with NO code change. The client `matchFallback` already
decodes — now CONSISTENT with the server instead of divergent.

### Tests

- Rust unit (routes.rs): decode cases — `%20`→space, Thai multi-byte
  (`%E0%B8%AA…`→`สวัสดี`-class), `%2F`→`/`, `+` stays `+`, `%FF` → WHOLE value
  raw, `%ZZ`/lone-`%` → WHOLE value raw, the mixed cases `a%ZZ%41` → raw
  `a%ZZ%41` and `%FF%41` → raw `%FF%41` (pin per-VALUE fallback), no-`%` value
  → `Cow::Borrowed` (assert via matches!), catch-all `{*rest}` route with
  `/files/a%2Fb/c` → param `a/b/c`, param() key-expr eval sees decoded value
  (key_expr or server-level test).
- Rust action router test: decoded action path param.
- Rust (or integration) coverage of the `/_brust/page/...` SPA-navigation
  match_path call site (server/mod.rs:605-625) — distinct entry, same decode.
- `runtime/cli/ssg.test.ts:414-418`: FLIP — `expect(html).toContain('post:sa wad-dee')`
  (decoded), delete the stale "known framework gap" comment block, replace
  with a one-liner noting params arrive decoded.
- `tests/integration.test.ts`: live-server route with an encoded param
  (space + Thai) → loader-rendered output shows the decoded value; action
  route param decoded too.
- Existing suites must stay green: any test that asserted encoded params is
  part of the breaking flip (expected: the ssg one). Grep `%20`/`%E0`/`%2F`
  assertions across runtime/, tests/, AND crates/ before claiming done
  (static_assets.rs has its own `%20` tests — those cover a DIFFERENT decoder
  and must NOT change).

### Docs (live docs site)

- `example/docs/content/static-export.md:72-76`: REMOVE the encoded-params
  sharp-edge paragraph + `decodeURIComponent` workaround; replace with a short
  positive note (params arrive decoded everywhere — build crawl and live).
- `example/docs/content/caching.md:176-177`: update the verbatim-matching
  note: `param()` values are now percent-decoded; header/cookie/query
  expression values remain verbatim.
- `example/docs/content/routing.md`: add a "Params are decoded" note in the
  dynamic-segments section (one short paragraph, includes the `%2F` consequence
  and the `+`-is-literal rule).

## Behavior invariants

1. Route matching is byte-identical to today (decode happens strictly after
   matchit `router.at`).
2. A param value with no `%` is byte-identical AND allocation-free
   (Cow::Borrowed) — ASCII slugs see zero cost.
3. Decoding is applied exactly once — no consumer re-decodes (client
   matchFallback operates on the browser URL, not envelope params; it stays).
4. L1 cache prefix keys built from `param()` change for encoded-param URLs
   (decoded values now appear in keys). Stale L1 entries keyed by encoded
   values simply expire — no correctness issue (cache keys are opaque).
5. Sentinel flows (`__brust_fallback__`) are `%`-free — unaffected.

## BREAKING (release note text)

> Path params now arrive percent-decoded in loaders, `cache.key`, `param()`
> key expressions, and action params (matching the SPA fallback client, which
> always decoded). If you worked around the old behavior with
> `decodeURIComponent(params.x)`, REMOVE it — double-decoding corrupts values
> containing literal `%`. Encoded `%2F` now decodes to `/` inside the value;
> route matching itself is unchanged.

## Acceptance criteria

1. Loader for `/post/:slug` requested as `/post/sa%20wad-dee` receives
   `slug === 'sa wad-dee'`; Thai slug `/post/สวัสดี` (browser-encoded) receives
   the Thai string. Same value in `cache.key` L2 and `param('slug')` L1 prefix.
2. `brust build --ssg` with `ssg.params()` values containing spaces/Thai
   prerenders pages whose loader saw decoded values (flipped ssg.test.ts
   assertion green). Round-trip pin: a user-supplied `ssg.params()` value
   containing a literal `%` (e.g. `50%`) must be crawled as `/post/50%25` and
   reach the loader as `50%` — verify how the crawler encodes expansion values
   today (plan-time check; add the encode if missing, else this is a test
   only).
3. Action route params decoded identically.
4. All baselines green: `bun run ci`, `bun test runtime/`, integration, ssg,
   cargo fmt/clippy/tests, `bun run docs:build`.
5. Docs updated (static-export, caching, routing) and deploy green on merge.

## Known limitations

- Apps that BUILT urls/keys from the previously-encoded values see different
  strings (the breaking change, documented above).
- `%2F` in a segment decodes to `/` in the value (full-decode policy) — apps
  that need the encoded form must re-encode (`encodeURIComponent`) themselves.
- Header/cookie/query key-expression values remain verbatim (only `param()`
  changed) — caching.md documents the asymmetry.
