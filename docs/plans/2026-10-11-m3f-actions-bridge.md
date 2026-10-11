# m3f-actions-bridge — Rust + napi + worker transport for the `fetch` call kind: prefix branch before the method gate, preflight/CORS, body cap, `FetchRequest`, framed `FetchResponse`, prefix script, `setActionsApp`

**RULED by lead Detoro 2026-10-11 (before dispatch): R1-R12 ALL ACCEPTED as their defaults (spec E3/E5 amended). Cross-lane contract confirmed with the elysia plan: A1 `url` = path + query UNCHANGED (prefix included); the elysia lane's `mountActions` mounts the user app under the prefix and hands the mounted app to `setActionsApp` — Rust strips nothing. ADDED to Task B9: regenerate `bench/attribution.patch` (it no longer applies after the store lanes changed pipeline.rs:336; this is the last wave-2 lane touching pipeline.rs) and verify `git apply --check`. Shared-file rule: this lane owns `makeDispatch`'s fetch branch + `setActionsApp` + `native.ts:18-31`; the elysia lane owns `startWorker` boot wiring + `run.ts`/`config.ts`/`build/**`; the lead merges adjacent hunks by hand.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f (worktree ~/code/brust-m3f) · lane: m3f-actions-bridge · tier: complex · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec §2.1 of `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` (E3, E4, the transport half of E5, the E6 prefix script; contracts A1, A2, A4; the Rust/napi consumer side of A3). After this lane:
- **Rust branch.** `brust-server` has `Config.actions: Option<ActionsConfig { prefix, max_body_bytes }>`, validated at `start`.
  - Every request whose path is the prefix or under it (segment-safe, 0.1.x `path_under_action_prefix`) goes to ONE worker call, `CallKind::Fetch` ("fetch").
  - The branch runs after the CORS preflight and before the GET/HEAD gate, the static roots and the page pipeline.
  - Rust enforces the body cap (413, with or without Content-Length), answers 415 for an encoded body, and never caches.
- **Wire.** The request crosses as A1 `FetchRequest` (inline JSON). The answer comes back in the SAB slot as A2 `[u32 LE meta_len][meta JSON {status, headers:[[k,v]…]}][body]`. Rust decodes it into a response, and the existing service-layer chokepoint stamps CORS on it.
- **napi.** `StartOptions` gains `cors` and `actions` (camelCase keys). The tsfn passes the kind `"fetch"`.
- **Prefix script.** For a non-default prefix, `render.rs` writes `<script>globalThis.__BRUST_ACTION_PREFIX__="<prefix>"</script>` immediately before the store tags (A4).
- **Worker.** `makeDispatch` answers `fetch`:
  - it builds a web `Request` and runs `app.fetch(req)` in a store scope, on the app registered with `setActionsApp(app)`;
  - it frames the `Response` into the slot (status, header pairs incl. every `Set-Cookie`, binary body);
  - an oversize answer becomes a documented 500.

A server without `actions` is byte-identical to today: same pages, same 405s, same `/_brust/*` 404s.

**Architecture:**
- Rust:
  - `config.rs` (ActionsConfig + validation);
  - NEW `actions.rs` (cap, encode, call, decode → response);
  - `pipeline.rs::handle` (one `if let` before the method gate; the body is kept);
  - `protocol.rs` (Fetch* types);
  - `dispatch.rs` (CallKind::Fetch, a decode-generic call, `call_worker_fetch`, `decode_fetch_frame`);
  - `render.rs` (the prefix tag);
  - `server/mod.rs::start` (validate, prebuild the tag).
- napi: `server.rs` (StartOptions + pure mapping fns), `dispatch.rs` (`kind_str`).
- TS: NEW `src/actions-bridge.ts`, `worker.ts` (one branch), `native.ts` (types). No Elysia import anywhere: the app is any `{ fetch(Request): Response | Promise<Response> }`.

**Tech Stack:** Rust nightly-2026-09-15, hyper 1 + http-body-util 0.1 (`Limited`), serde_json 1, napi-rs, Bun canary (web `Request`/`Response`/`Headers.getSetCookie`), TS 7 via `bun check`.

**Spec:** design E3–E6, §2.1, §3 A1–A4. Global lane rules: design §5 (lanes from `m3f`, the lead merges).

## Facts the plan rests on (m3f @ 03fed3f)

- **F1 — the body is dropped today.**
  - `pipeline.rs:73` `let (parts, _body) = req.into_parts();`.
  - Order today: preflight :83-93, GET/HEAD gate :95-98, `/ping` and stats :99-107, the static roots `/_brust/` and `/public/` :108-128, then `page()`. The HEAD tail (:142-151) strips the body and keeps Content-Length.
  - The default prefix `/_brust/action` sits under `/_brust/`, so the branch MUST come before :95.
- **F2 — the CORS core is complete but unreachable from JS.**
  - `config.rs:38-78` `CorsConfig::validate` (empty origins; `credentials && '*'`).
  - `server/mod.rs:115-117` boot error `cors: …`; `:145` resolves it; `:316-333` stamps EVERY response at the `service_fn` chokepoint (insert-if-absent ACAO/ACAC/ACEH, Vary appended).
  - `brust-napi/src/server.rs:90-106` `StartOptions` has no `cors`; `:124-133` uses `..Config::default()`.
  - So an action response gets CORS once napi passes it. The branch NEVER stamps (cors.rs:9-14).
- **F3 — the response reader is JSON-only.** `dispatch.rs:215-298` `call_worker_planned`: claim → inline JSON → `dispatch.call` → `len` bounds check (:250-254) → `from_utf8` + `serde_json::from_str` (:256-260), all under the claim (`drop(claim)` :262). A framed body must be copied out inside that claimed section. `CallKind` (:42-47): `Loader`, `Jobs`, `rename_all = "lowercase"`, not `non_exhaustive`.
- **F4 — exhaustive `CallKind` matches outside `src/`.** These are `brust-napi/src/dispatch.rs:57-62` (`kind_str`), `tests/common/fake_bun.rs:145-148` and `:211-214`, and `tests/single_roundtrip.rs:319-321`. Adding `Fetch` breaks all four at compile time.
- **F5 — the request envelope.** `routing/routes.rs:323` `fn build_request_envelope` is private. `RequestEnvelope` (:29-38) serialises headers/cookies/search as objects (`serialize_as_map` :16-23), so repeated header names collapse. Hence A1 carries `headers` as pairs AND `req`.
- **F6 — injection.** `render.rs:315-372` `inject_page_assets_into(html, chain, m, store)` builds `[store tags] + runtime + chunks + react` and returns early when nothing is dynamic (:352-354). `inject_assets_into` (:304-306) delegates. `pipeline.rs:712` (`render_document`) is the only request-path call. `benches/render.rs` and `tests/render.rs` call the public fns.
- **F7 — canned errors.** `server/body.rs:233-262` `error_400`, `error_413` (`payload too large`) and `error_415` (`unsupported media type`) are `#[allow(dead_code)]`. `is_framing_header` (:67-71) covers content-length/transfer-encoding/connection.
- **F8 — dependencies.** `Cargo.lock` has no `base64`. `brust-server/Cargo.toml` has `http-body-util = "0.1"` (`Limited`, `LengthLimitError`) and `bytes`.
- **F9 — v2 has no request context.** `grep -rn "AsyncLocalStorage\|runInRequestContext" packages/brust/src packages/runtime-dom/src` hits only `store/server-context.ts:4,11`. Loaders get `req` explicitly (`routes.ts:18-30`). See R1.
- **F10 — worker transport.**
  - `worker.ts:265-289` `makeDispatch` parses inline JSON, dispatches `loader`/`jobs`, and always ends in `writeSlot` (JSON, :78-88). An unknown kind gets `{error}` JSON, whose first 4 bytes read as a huge `meta_len`, so Rust reports a `BadResponse` 500, never garbage.
  - `SLOT_BYTES = 256 * 1024` (:292); slot sub-region = `floor(byteLength / slots)`.
  - `native.ts:31` types `kind` as `'loader' | 'jobs'`.
- **F11 — 0.1.x behaviour to port.**
  - `brust-core/src/config.rs:358-363` `path_under_action_prefix` (tests `brust/src/lib.rs:641-656`).
  - `brust/src/lib.rs:192-202` prefix check; `:205-218` CORS mapping + validate; `:79-98` `NapiCorsOptions` keys.
  - `brust-core/src/server/mod.rs:890-904`: 413 on Content-Length first, then on the collected length. `:906-926`: json/urlencoded/empty → text, multipart → b64, else 415.
  - `runtime/routes.ts:2098-2135` `packSingleChunkResponse`: an oversize answer packs a small 500.
  - `render/stream.rs:79-108` `response_from_meta`: skips framing headers, no gzip.
  - `tests/cors.integration.test.ts:79-180`: 7 CORS cases.
- **F12 — Elysia 2.0.0-beta.30** (`~/.bun/install/cache/elysia@2.0.0-4f112376e0f3db35@@@1/dist/handler/fetch.mjs:15`) finds the path with `url.indexOf("/", authorityEnd(url))`. Any `http://<host>` origin parses.
- **F13 — CI lists TS test files explicitly** (`.github/workflows/ci.yml:120-126`). `cargo test --workspace` (:42) picks up new Rust test files.

## Rulings requested from the lead before dispatch

Each has a default that the implementer follows unless the lead answers differently.

- **R1 — no `runInRequestContext` (F9).** The fetch runs in `runInStoreContext` only. A1's `req` still crosses, so a future request context needs no wire change. Default: ACCEPT (amend E5).
- **R2 — body encoding.**
  - `text` when the content type is empty, `application/json`, `*+json`, `application/x-www-form-urlencoded` or `text/*` AND the bytes are valid UTF-8. Otherwise `b64` (lossless).
  - 415 only for a `Content-Encoding` other than `identity`.
  - Unlike 0.1.x, an unknown type is not 415 and bad UTF-8 is not 400: Elysia owns parsing and validation (E3).
  - Default: ACCEPT. Alternative: the 0.1.x whitelist.
- **R3 — OPTIONS under the prefix that is not an allowed preflight** (no ACRM, a disallowed origin, or no CORS config) is forwarded to the worker (E3: the subtree is Elysia's). In 0.1.x it was a Rust 405. Outside the prefix the 405 stays. Default: ACCEPT.
- **R4 — GET/HEAD bodies are not read** (`body: null`; `new Request` forbids one anyway). Default: ACCEPT.
- **R5 — base64 = a std-only encoder** in `actions.rs` with the RFC 4648 §10 vectors; no new crate (F8). Default: ACCEPT. Alternative: `base64 = "0.22"`.
- **R6 — Rust learns `actions`/`cors` only from napi `StartOptions`.** `manifest.rs` keeps ignoring an `actions` key. The `run.ts` wiring (manifest `actions` + `[cors]` → `startServer`) is the ELYSIA lane's. This lane's e2e calls `startServer` directly. Default: ACCEPT.
- **R7 — prefix validation (boot error `actions: …`).**
  - It starts with `/`, does not end with `/`, and each segment matches `[A-Za-z0-9._~-]+` and is not `.`/`..`.
  - No overlap, in either direction, with `/ping`, `/public`, `/_brust/client` or `/_brust/cache` (so `/_brust` is refused).
  - No manifest route whose literal head (before the first `{`) lies under it.
  - `max_body_bytes ≥ 1`.
  - Default: ACCEPT.
- **R8 — Request origin.** The worker uses `http://<host>`, where `<host>` is the `host` pair if it matches `^[A-Za-z0-9.\-:\[\]]+$`, else `localhost`. On HTTP/2, Rust appends `("host", uri.authority)` when no `host` header exists. The scheme is always `http` (A1 has no scheme; Elysia routes on path + query, F12). Default: ACCEPT.
- **R9 — response rules.**
  - A meta status outside `200..=599` → 500 + `error!`.
  - Framing headers are dropped, other pairs `append`ed, and an invalid pair is dropped with `warn!`.
  - No gzip, never L1.
  - CONNECT/TRACE/TRACK under the prefix → Rust `501 not implemented` (`new Request` throws on them).
  - Default: ACCEPT.
- **R10 — oversize response.** The worker writes status 500 with `content-type: text/plain; charset=utf-8` and body exactly `brust: action response exceeds <sub> bytes` (`<sub>` = slot capacity). It logs `[brust] action response <total> bytes exceeds the <sub>-byte slot (F82) — answered 500`. Rust's `len > cap` guard stays a `BadResponse` 500. Default: ACCEPT.
- **R11 — stats.** An action bumps `worker_calls` (and `timed_out_calls` on 504), not `loader_calls`. No new stats field. Default: ACCEPT.
- **R12 — the A4 tag only on pages with client code** (after the `any_dynamic` early return, as store tags; store R4). Default: ACCEPT.

## Global Constraints

- **Lane:** `cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-actions-bridge -b lane/m3f-actions-bridge m3f && cd ../brust-lane-m3f-actions-bridge && bun install --frozen-lockfile` (NOT `conclave lane start`, which branches from `main`). Line numbers are at m3f @ 03fed3f. If code moved, re-anchor on the quoted text and note it.
- NO PR. READY goes on the Conclave task; the lead merges into `m3f`. The elysia lane runs in parallel, and its worker/run wiring imports this lane's `actions-bridge.ts` and napi fields. Merge this lane first, or that lane merges `origin/m3f` after it.
- **TDD:** every task writes its failing test first, runs it and pastes the failure, then implements. Contracts A1–A4 are verbatim; a different value needs a `task challenge`.
- **Byte-identical without actions:**
  - Copy `/private/tmp/claude-501/-Users-detoro-code-brust/84499717-7bab-40dc-be3d-c896c07cf5ce/scratchpad/m3p-d/{snap,cmp}.sh` to `$OUT` and set `ROOT=` to your lane.
  - Run `$OUT/snap.sh before` at B1. After every code task, `$OUT/snap.sh bN && $OUT/cmp.sh before bN` must print `IDENTICAL` ×4 (pokedex `/`, `/pokemon/pikachu`; bench `/dex`, `/team`), and `grep -c __BRUST_ACTION_PREFIX__ $OUT/body-bN-*` must print 0.
  - The Rust tests `no_actions_config_is_byte_identical` (B3) and `default_prefix_adds_no_tag` (B5) cover the same rule.
- **Stale addon:** after ANY Rust edit, run `cd packages/brust && bun run build:debug` before any TS test (memory `stale-napi-node-after-compiler-change`).
- Never `git add -A`; stage by name. `git status --short` before each commit lists exactly the task's files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Gates** (green before each code commit; all before READY):
  - `cargo fmt --all -- --check`
  - `cargo clippy -p brust-server -p brust-napi --no-deps -- -D warnings`
  - `cargo test -p brust-server` (`--test actions`, `--test single_roundtrip`, `--test plan_offer` alone if a combined run flakes on a port); `cargo test -p brust-server --test inputs job_keys_are_pinned`
  - `cargo test -p brust-napi`; `cargo bench -p brust-server --bench render --no-run`; `cd examples/pokedex && bun test && bun run typecheck`; `bun test --timeout 120000 tests/server/pokedex.test.ts`
  - `cd packages/brust && bun run build:debug && bun run typecheck && bun test` (server-starting files alone: `test/e2e.test.ts`, `test/e2e-store.test.ts`, `test/napi-server.test.ts`, `test/actions-napi.test.ts`, `test/cli.test.ts`)
- **Perf:** no benches except B9's 3-round interleaved S/D/I sanity under `bench:host-lock`. STOP if any probe drops more than 1%.
- **Boundary (exact):**
  - Rust (`crates/brust-server`):
    - `src/config.rs`: `ActionsConfig`, the two `DEFAULT_*` consts, `under`, `Config.actions`, `Server.actions` + `Server.action_prefix_tag`.
    - `src/server/mod.rs`: `start` only (:112-155).
    - NEW `src/actions.rs`; `src/lib.rs` (`mod actions;` + re-exports).
    - `src/pipeline.rs`: ONLY `handle` (:72-153) and `render_document`'s inject call (:712) + its import (:31).
    - `src/protocol.rs`: new types after `JobResult` (:216-222) + unit tests.
    - `src/dispatch.rs`: `CallKind` (:42-47), `call_worker_planned` (:215-298, decode made generic), new `call_worker_fetch` + `decode_fetch_frame`, unit tests.
    - `src/render.rs`: new `inject_document_assets_into`; `inject_page_assets_into` (:315) delegates.
    - `src/routing/routes.rs:323`: `fn` → `pub(crate) fn`.
    - `src/server/body.rs`: drop `#[allow(dead_code)]` on `error_400`/`error_413`/`error_415`.
    - Tests: NEW `tests/actions.rs`; `tests/common/{mod.rs,fake_bun.rs}`; `tests/single_roundtrip.rs:319` (one arm); `tests/render.rs` additions.
  - napi: `crates/brust-napi/src/server.rs` (StartOptions, `NapiCorsOptions`, `NapiActionsOptions`, 2 pure fns, tests) and `src/dispatch.rs` (`kind_str` + test).
  - TS:
    - NEW `packages/brust/src/actions-bridge.ts`;
    - `src/worker.ts` (one import + the first line of the fn `makeDispatch` returns, :265-268);
    - `src/native.ts` (:18-31);
    - NEW `test/{actions-bridge,actions-napi}.test.ts`;
    - `.github/workflows/ci.yml` (:120 list + one line).
  - NOT touched:
    - `packages/brust/src/{run.ts,config.ts,build/**}` and `startWorker` (:310-331) (elysia lane);
    - `crates/brust-server/src/{manifest.rs,inputs.rs,pool.rs,server/cors.rs}`;
    - `packages/runtime-dom/**`, `examples/**`, `bench/**`, `docs/**`.
- **Do not re-decide:** E1–E9, A1–A4, the SAB rule (`dispatch.rs:8-21`), the CORS chokepoint rule, `inputs::job_key` bytes, the loader/jobs JSON wire.

## Interfaces this lane exposes (the elysia lane codes against these verbatim)

```ts
// packages/brust/src/actions-bridge.ts
/** A3: the manifest block `brust build` writes (the elysia lane's writer). `entry` is relative to dist. */
export interface ActionsManifest { entry: string; prefix: string; maxBodyBytes: number }
/** What the worker drives: an Elysia 2 app (`app.fetch`, web-standard), or anything with that shape. */
export interface ActionsApp { fetch(request: Request): Response | Promise<Response> }
/** Registers this worker's actions app. Call once at worker boot, before `registerWorker`. `null` unregisters (tests).
 * Throws TypeError when `app` has no `fetch` function. */
export function setActionsApp(app: ActionsApp | null): void
export function getActionsApp(): ActionsApp | null
```

Expected of the elysia lane:
1. In `startWorker`, after the manifest read: `const a = (manifest as { actions?: ActionsManifest | null }).actions; if (a) setActionsApp(await loadActionsApp(join(dist, a.entry)))`. The loader and its boot errors are that lane's.
2. In `run.ts`: `startServer({ …, actions: a ? { prefix: a.prefix, maxBodyBytes: a.maxBodyBytes } : undefined, cors: cfg.cors })`. That lane maps the `[cors]` snake_case keys (`expose_headers`, `max_age_seconds`) onto the napi keys.
3. `native.ts` (this lane) defines:
   - `StartOptions.actions?: { prefix?: string; maxBodyBytes?: number }`;
   - `StartOptions.cors?: { origins: string[]; methods?: string[]; headers?: string[]; exposeHeaders?: string[]; credentials?: boolean; maxAgeSeconds?: number }`;
   - `WorkerFn` kind `'loader' | 'jobs' | 'fetch'`.

## Review Focus

1. **The body is never read for page routes.** `handle` moves `incoming` ONLY into `actions::handle`.
   - Pinned by `page_route_never_reads_the_body`: GET `/pokemon/pikachu` and POST `/` with never-ending bodies answer 200/405 within 2 s, and `fetch_count() == 0`.
   - Pinned by `no_actions_config_is_byte_identical`.
2. **The cap holds without Content-Length.** A declared length above the cap → 413 before any read (`size_hint().lower()`). A chunked body is read through `http_body_util::Limited` (`LengthLimitError` → 413). The worker is never called on a 413.
   - Pinned by `body_over_cap_by_content_length_is_413`, `chunked_body_over_cap_is_413` (300 × 1 KiB, no CL) and `chunked_body_at_cap_is_forwarded`.
3. **Framing with binary bodies and repeated `Set-Cookie`.** Rust copies `bytes[4+meta_len..len]` BEFORE the claim drops (F3). Pairs are appended in order.
   - Pinned by the `decode_fetch_frame` table (0..=255 body, two cookies, `meta_len` > len, len < 4, bad meta) and `framing_round_trip_binary_and_two_cookies`.
   - Pinned by TS "writeFramed/readFramed round trip" + "two Set-Cookie survive" and the napi e2e "binary body and two cookies through Rust".
4. **CORS parity with 0.1.x.** Preflight under the prefix → 204 with full headers. Action responses are stamped at the chokepoint (insert-if-absent, Vary appended). A disallowed origin is processed without ACAO. Pages are stamped. Static Vary merges. `credentials + '*'` is a boot error through BOTH `start` and napi `startServer`.
   - Pinned by `tests/actions.rs::cors_*` (7 ported cases, R3 noted).
   - Pinned by `actions-napi.test.ts`, which asserts the message `/cors: .*wildcard/`, not a bare `toThrow()` (memory "toThrow green-lie").
5. **The worker fetch runs in a store scope** (R1). `runFetch` wraps BOTH `app.fetch(req)` and `res.arrayBuffer()` in one `runInStoreContext`.
   - Pinned by "fetch runs in a store scope" (`getServerInstance` works inside, throws `/outside a request scope/` outside).
   - Pinned by "two interleaved fetches see their own scope" (20 ms / 1 ms).
   - Pinned by "the frame carries no store" (meta keys exactly `status`, `headers`).
6. **The oversize path.** The worker answers R10's 500, which always fits (< 200 bytes), and Rust relays it with that exact body. A worker `len > cap` or a JSON answer → Rust `BadResponse` 500 + `error!`.
   - Pinned by TS "oversize body → 500 frame", `worker_oversize_frame_is_relayed_as_500`, `json_answer_to_fetch_is_500` and `fetch_len_over_capacity_is_bad_response`.

## Dispatch table

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-actions-bridge-1` lane + baseline + ActionsConfig | routine | implementer | lane created; R1–R12 answered | `$OUT/snap.sh before` saved; config unit tests (prefix port, validation table, route shadow) red then green; `start` boot errors; gates; commit `feat(server): actions config — segment-safe prefix, body cap, boot validation (M3-F E1, E3)` |
| `m3f-actions-bridge-2` wire types + CallKind::Fetch + framed decode | standard | implementer | B1 | protocol JSON pinned; `decode_fetch_frame` table; `call_worker_fetch` round trip + `len > cap`; four matches updated (F4); `kind_str(Fetch) == "fetch"`; loader/jobs tests unchanged; commit `feat(server): fetch call kind — FetchRequest (A1) inline, [u32 LE len][meta][body] response (A2)` |
| `m3f-actions-bridge-3` the actions branch | complex | implementer | B2 | `tests/actions.rs` core tests (methods, 405 outside, 413 ×2, 415, 501, text/b64, never read for pages, never cached, HEAD, 503/504/500, framing) alone ×3; IDENTICAL ×4; commit `feat(server): actions branch before the method gate — prefix subtree to one fetch call, body cap, encoding (M3-F E3, E4)` |
| `m3f-actions-bridge-4` CORS parity | standard | implementer | B3 | 7 ported cases green with NO `cors.rs`/branch change; commit `test(server): CORS parity for actions and pages through the chokepoint (M3-F E3)` |
| `m3f-actions-bridge-5` prefix script (A4) | standard | implementer | B1 | render tests + page tests (tag once, L1 HIT same bytes, default/None identical); old render tests unmodified; `cargo bench … --no-run`; IDENTICAL ×4; commit `feat(server): __BRUST_ACTION_PREFIX__ script before the store tags for a non-default prefix (M3-F A4, E6)` |
| `m3f-actions-bridge-6` napi StartOptions | standard | implementer | B2 | `cargo test -p brust-napi`; `build:debug`; `native/index.d.ts` shows `cors?`/`actions?`; `native.ts` types; typecheck; commit `feat(napi): StartOptions.cors and .actions; fetch call kind (M3-F A3)` |
| `m3f-actions-bridge-7` worker transport | complex | implementer | B6 | `test/actions-bridge.test.ts` green ×5; `worker.test.ts`/`worker-store.test.ts` unmodified green; commit `feat(core): worker fetch transport — setActionsApp, web Request in a store scope, framed Response (M3-F E4, E5)` |
| `m3f-actions-bridge-8` napi e2e + CI | standard | implementer | B3–B7 | `test/actions-napi.test.ts` alone ×3; ci.yml lists both new files; commit `test(core): actions through the real Rust server and worker dispatch (M3-F)` |
| `m3f-actions-bridge-9` perf sanity + READY | standard | implementer | B8 | IDENTICAL ×4; S/D/I 3 rounds paired median ≥ −1% (else STOP); all gates; READY |

---

### Task B1: Lane, baseline, `ActionsConfig` + boot validation

**Files:** Modify `crates/brust-server/src/config.rs`, `src/server/mod.rs` (`start`), `src/lib.rs`.

- [ ] **Step 1: Lane + baseline.** Create the lane (Global), then:
  - `export OUT=<scratchpad>/m3f-actions && mkdir -p $OUT`; copy `snap.sh`/`cmp.sh` and set `ROOT`.
  - `cd packages/brust && bun run build:debug && cd ../.. && $OUT/snap.sh before`, then paste `wc -c $OUT/body-before-*`.
- [ ] **Step 2: Failing tests** (`config.rs` `mod tests`).
  - `prefix_match_is_segment_safe` (0.1.x `lib.rs:645-655`, extended):
    - `/_brust/action`, `/_brust/action/notes` and `/_brust/action/notes/5` → true;
    - `/_brust/actionXYZ`, `/_brust/act`, `/other` and `/_brust/action2/x` → false.
  - `actions_validation_table`:
    - `Ok`: `/_brust/action`, `/api`, `/api/v1`, `/a.b~c-d_e`;
    - `Err`, message quotes the prefix: `""`, `api`, `/`, `/api/`, `/a//b`, `/a/./b`, `/a/../b`, `/a b`, `/a?x`, `/a%2Fb`;
    - `Err`, reserved: `/ping`, `/public`, `/public/x`, `/_brust`, `/_brust/client`, `/_brust/client/x`, `/_brust/cache`, `/_brust/cache/stats`;
    - `Err`: `max_body_bytes: 0`.
  - `actions_prefix_may_not_shadow_a_route` (fixture manifest via `Manifest::load`): `/pokemon` → `Err` containing `shadows route "/pokemon/{name}"`; `/poke` → `Ok`.
  - `start_rejects_bad_actions_and_bad_cors` (`server/mod.rs` tests):
    - prefix `/_brust` → `Err` starting `actions: `;
    - `CorsConfig { origins: ["*"], credentials: true, .. }` → `Err` starting `cors: ` and containing `wildcard`.
- [ ] **Step 3: Implementation** (`config.rs`):
```rust
/// 0.1.x defaults (E1).
pub const DEFAULT_ACTION_PREFIX: &str = "/_brust/action";
pub const DEFAULT_MAX_ACTION_BODY_BYTES: usize = 262_144;
/// Paths the actions prefix may not overlap in either direction (R7).
const RESERVED: &[&str] = &["/ping", "/public", "/_brust/client", "/_brust/cache"];

/// M3-F E1/E3: the actions subtree. `None` in [`Config`] = no actions (byte-identical server).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionsConfig { pub prefix: String, pub max_body_bytes: usize }

impl Default for ActionsConfig {
    fn default() -> Self { Self { prefix: DEFAULT_ACTION_PREFIX.into(), max_body_bytes: DEFAULT_MAX_ACTION_BODY_BYTES } }
}

/// 0.1.x `path_under_action_prefix` (brust-core config.rs:358-363): `path` is `p` or lies under it.
pub(crate) fn under(path: &str, p: &str) -> bool {
    path == p || (path.len() > p.len() && path.as_bytes()[p.len()] == b'/' && path.starts_with(p))
}

impl ActionsConfig {
    pub fn is_under(&self, path: &str) -> bool { under(path, &self.prefix) }
    pub fn is_default_prefix(&self) -> bool { self.prefix == DEFAULT_ACTION_PREFIX }
    /// R7; `start` prefixes the message with `actions: `.
    pub fn validate(&self, m: &crate::manifest::Manifest) -> Result<(), String> {
        let p = self.prefix.as_str();
        let seg_ok = |s: &str| !s.is_empty() && s != "." && s != ".."
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'));
        if !p.starts_with('/') || p.len() < 2 || p.ends_with('/') || !p[1..].split('/').all(seg_ok) {
            return Err(format!("prefix must start with '/', must not end with '/', and each segment must be [A-Za-z0-9._~-] (not '.' or '..'): {p:?}"));
        }
        if let Some(r) = RESERVED.iter().find(|r| under(p, r) || under(r, p)) {
            return Err(format!("prefix {p:?} overlaps the reserved path {r:?}"));
        }
        if let Some(rt) = m.routes.iter().find(|rt| {
            let head = rt.pattern.split('{').next().unwrap_or("");
            under(head.trim_end_matches('/'), p) || under(head, p)
        }) {
            return Err(format!("prefix {p:?} shadows route {:?}", rt.pattern));
        }
        if self.max_body_bytes == 0 { return Err("maxBodyBytes must be at least 1".into()); }
        Ok(())
    }
}
```
  - `Config` gains `pub actions: Option<ActionsConfig>` (default `None`).
  - `Server` gains `pub(crate) actions: Option<ActionsConfig>` and `pub(crate) action_prefix_tag: Option<Box<str>>`.
  - `start` (after the cors check :115-117): `if let Some(a) = &cfg.actions { a.validate(&loaded.manifest).map_err(|e| format!("actions: {e}"))?; }`.
  - In the `Server` literal: `action_prefix_tag: cfg.actions.as_ref().filter(|a| !a.is_default_prefix()).map(|a| format!("<script>globalThis.__BRUST_ACTION_PREFIX__=\"{}\"</script>", a.prefix).into_boxed_str())` (A4 verbatim; validated chars only, so no escaping) and `actions: cfg.actions`.
  - `lib.rs`: `pub use config::{ActionsConfig, DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES};`. The `start` doc lists `"actions: …"`.
- [ ] **Step 4:** `cargo test -p brust-server` + gates. Commit `feat(server): actions config — segment-safe prefix, body cap, boot validation (M3-F E1, E3)`.

### Task B2: Wire types, `CallKind::Fetch`, framed decode

**Files:**
- `crates/brust-server/src/{protocol.rs, dispatch.rs, routing/routes.rs:323}`;
- `crates/brust-napi/src/dispatch.rs:57-62`;
- `tests/common/{fake_bun.rs, mod.rs}`, `tests/single_roundtrip.rs:319`.

- [ ] **Step 1: Failing tests.**
  - `protocol.rs` `fetch_request_json_is_pinned`: the request below serialises to exactly `{"method":"POST","url":"/_brust/action/team?x=1","headers":[["content-type","application/json"],["set-cookie","a=1"],["set-cookie","b=2"]],"body":{"text":"{\"id\":1}"},"req":{…}}`.
    - Request: `FetchRequest { method: "POST", url: "/_brust/action/team?x=1", headers: [content-type json, set-cookie a=1, set-cookie b=2], body: Some(Text("{\"id\":1}")), req }`.
    - Also `B64("AAE=")` → `"body":{"b64":"AAE="}` and `None` → `"body":null`.
  - `fetch_meta_reads_pairs`: `{"status":201,"headers":[["set-cookie","a=1"],["set-cookie","b=2"]],"extra":1}` → two pairs; missing `headers` → empty.
  - `dispatch.rs` `decode_fetch_frame_table`:
    - meta `{"status":200,"headers":[["x","1"]]}` + body `0u8..=255` → equal;
    - 3 bytes → `BadResponse("fetch frame shorter than 4 bytes")`;
    - `meta_len == len` → `BadResponse` ∋ `meta_len`;
    - meta `{` → `BadResponse` ∋ `meta`.
  - `call_worker_fetch_round_trips_a_frame` (`MockDispatch::replying(&frame)`), `fetch_len_over_capacity_is_bad_response` (`MockDispatch::reply_len(cap + 1)`), and `CallKind::Fetch` serialises to `"fetch"`.
  - napi `kind_names_match_the_wire` gains `assert_eq!(kind_str(CallKind::Fetch), "fetch")`.
- [ ] **Step 2: Implementation** (`protocol.rs`, after `JobResult`):
```rust
/// A1 `fetch` request: `{ method, url, headers: [[k,v]…], body: {text}|{b64}|null, req }`. `headers` are PAIRS
/// (repeated names survive; `req.headers` is an object and collapses them — F5). `url` = path + query as received.
#[derive(Debug, Serialize)]
pub struct FetchRequest<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: Vec<(Cow<'a, str>, Cow<'a, str>)>,
    pub body: Option<FetchBody>,
    pub req: RequestEnvelope<'a>,
}
/// A1 body (R2), externally tagged: `{"text": …}` / `{"b64": …}`.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FetchBody { Text(String), B64(String) }
/// A2 meta `{ status, headers: [[k,v]…] }`; unknown keys ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FetchMeta { pub status: u16, #[serde(default)] pub headers: Vec<(String, String)> }
/// A decoded `fetch` answer; `body` was copied out of the slot while the claim was held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResponse { pub status: u16, pub headers: Vec<(String, String)>, pub body: bytes::Bytes }
```
  - `dispatch.rs`: `CallKind { Loader, Jobs, Fetch }`. Module doc (:23-26): "three call kinds; `fetch` answers are framed (A2), loader/jobs stay plain JSON".
  - Today's body of `call_worker_planned` moves verbatim into `call_worker_decoded`. Only :256-260 change, to `let parsed = decode(bytes);`.
```rust
/// The claimed round trip, the slot bytes decoded by `decode` INSIDE the claim (the slot is reused once it drops — F3).
async fn call_worker_decoded<Req: Serialize, R: Send + 'static, D>(
    pool: &Arc<WorkerPool>, timeout: Duration, call_timeout: Duration, kind: CallKind,
    req: &Req, seed: Option<PlanBox>, decode: D,
) -> Result<(R, Option<PlanBox>), CallError>
where D: FnOnce(&[u8]) -> Result<R, CallError> + Send + 'static { /* today's body */ }

pub async fn call_worker_planned<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(
    pool: &Arc<WorkerPool>, timeout: Duration, call_timeout: Duration, kind: CallKind, req: &Req, seed: Option<PlanBox>,
) -> Result<(Resp, Option<PlanBox>), CallError> {
    call_worker_decoded(pool, timeout, call_timeout, kind, req, seed, |bytes| {
        std::str::from_utf8(bytes)
            .map_err(|e| CallError::BadResponse(format!("response not UTF-8: {e}")))
            .and_then(|s| serde_json::from_str::<Resp>(s).map_err(|e| CallError::BadResponse(e.to_string())))
    }).await
}

/// One `fetch` round trip (A1 in, A2 out). Never planned.
pub async fn call_worker_fetch(pool: &Arc<WorkerPool>, timeout: Duration, call_timeout: Duration,
                               req: &FetchRequest<'_>) -> Result<FetchResponse, CallError> {
    call_worker_decoded(pool, timeout, call_timeout, CallKind::Fetch, req, None, decode_fetch_frame).await.map(|(r, _)| r)
}

/// A2: `[u32 LE meta_len][meta JSON][body]`; the body is copied (the slot is about to be released).
pub fn decode_fetch_frame(b: &[u8]) -> Result<FetchResponse, CallError> {
    let Some(head) = b.get(..4) else { return Err(CallError::BadResponse("fetch frame shorter than 4 bytes".into())) };
    let n = u32::from_le_bytes(head.try_into().expect("4 bytes")) as usize;
    let Some(meta) = b.get(4..4usize.saturating_add(n)) else {
        return Err(CallError::BadResponse(format!("fetch frame meta_len {n} exceeds {}", b.len() - 4)));
    };
    let m: FetchMeta = serde_json::from_slice(meta).map_err(|e| CallError::BadResponse(format!("fetch frame meta: {e}")))?;
    Ok(FetchResponse { status: m.status, headers: m.headers, body: bytes::Bytes::copy_from_slice(&b[4 + n..]) })
}
```
  - `routes.rs:323` → `pub(crate) fn build_request_envelope`. napi `kind_str`: `CallKind::Fetch => "fetch"`.
  - FakeBun (`tests/common/fake_bun.rs`):
    - fields `fetch: Option<Box<dyn Fn(Value) -> Vec<u8> + Send + Sync>>`, `fetch_calls`, `last_fetch`;
    - `with_fetch(self: Arc<Self>, f)` (the `with_after_plan` pattern), `fetch_count()`, `last_fetch()`;
    - `reply`: `CallKind::Fetch => return (self.fetch.as_ref().expect("FakeBun: no fetch responder"))(req)`;
    - the `call` match gains the `Fetch` arm;
    - `counts()` stays a 2-tuple.
  - `tests/common/mod.rs`: `pub fn frame(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8>` (the A2 writer for responders).
  - `single_roundtrip.rs:319`: `CallKind::Fetch => unreachable!("no fetch in this test")`.
- [ ] **Step 3:** `cargo test -p brust-server` (loader/jobs dispatch tests unchanged), `cargo test -p brust-napi`, gates. Commit `feat(server): fetch call kind — FetchRequest (A1) inline, [u32 LE len][meta][body] response (A2)`.

### Task B3: The actions branch in `handle`

**Files:**
- Create `crates/brust-server/src/actions.rs`, `tests/actions.rs`.
- Modify `src/pipeline.rs` (`handle` :72-153), `src/lib.rs`, `src/server/body.rs` (the `allow`s on `error_400/413/415`), `tests/common/mod.rs`.

- [ ] **Step 1: Test helpers** (`tests/common/mod.rs`):
  - `boot_actions(fake, dist, actions: ActionsConfig, cors: Option<CorsConfig>)`; `request_body(s, method, path, headers, body: Vec<u8>) -> (u16, HeaderMap, Vec<u8>)` (`Full<Bytes>` → Content-Length); `request_chunked(…, chunks: Vec<Vec<u8>>)` (`StreamBody`, no size hint → chunked);
  - `request_open_body(…)`: a `StreamBody` over a `ReceiverStream` whose sender stays alive (a never-ending body), wrapped in `tokio::time::timeout(2s)` that panics on timeout.
- [ ] **Step 2: Failing tests** (`tests/actions.rs`).
  - Setup: responder `echo(req) = frame(200, [("content-type","application/json")], to_vec(&req))`; server `boot_actions(fake().with_fetch(echo), &fx(), ActionsConfig::default(), None)` unless stated.
  - `every_method_under_the_prefix_reaches_the_worker`: GET/POST/PUT/PATCH/DELETE/OPTIONS (no preflight headers) on `/_brust/action/team?x=1` → 200, with `last_fetch()["method"]` = the method and `["url"]` = `/_brust/action/team?x=1`. Also `/_brust/action` itself; `fetch_count() == 7`.
  - `outside_the_prefix_keeps_405_and_404`: POST `/` → 405 `Allow: GET, HEAD`; POST `/_brust/actionX` → 405; GET `/_brust/action2` → 404; no fetch.
  - `no_actions_config_is_byte_identical`: `boot(fake())` → POST `/_brust/action/x` 405 and GET 404, same status/body/headers (minus `date`) as at the lane base.
  - Cap tests (cap 1024 unless stated; never a fetch on 413):
    - `body_over_cap_by_content_length_is_413` (1025 bytes → 413 `payload too large`);
    - `chunked_body_over_cap_is_413` (cap 262144, 300 × 1024);
    - `chunked_body_at_cap_is_forwarded` (256 × 1024 `b'a'`, `text/plain` → `body.text.len() == 262144`).
  - `content_encoding_is_415` (`gzip` → 415; `identity` → forwarded).
  - `body_encoding_text_vs_b64` (R2):
    - text: `application/json` `{"a":1}`, no CT, `text/plain; charset=utf-8`, urlencoded, `application/merge-patch+json`;
    - b64: octet-stream `[0,1,255]` → `{"b64":"AAH/"}`, multipart, `text/plain` with `[0xff]`;
    - empty POST → `null`.
  - `get_and_head_bodies_are_not_read` (R4: GET with an open body → 200 in < 2 s, `body: null`) and `page_route_never_reads_the_body` (Review Focus 1).
  - `headers_cross_as_pairs_minus_framing`: two `x-dup` → both pairs in order; no `content-length`/`transfer-encoding`/`connection`; a `host` pair; `last_fetch()["req"]["headers"]["x-dup"]` present.
  - `framing_round_trip_binary_and_two_cookies`: responder `frame(201, [ct octet-stream, set-cookie a=1; Path=/, set-cookie b=2; Path=/, x-custom v], 0..=255)`. Via `request_raw`: 201, `get_all("set-cookie")` both in order, body equal, no `x-brust-cache`.
  - `framing_headers_from_the_worker_are_dropped` (meta `content-length: 999` + `transfer-encoding: chunked` → the real Content-Length).
  - `never_cached`: the same GET twice → `fetch_count() == 2`, `loader_calls == 0`, `worker_calls == 2` (R11).
  - `head_under_the_prefix_strips_the_body`: the worker sees `HEAD`; empty body; Content-Length = the frame body length.
  - `connect_trace_track_are_501` (R9) and `bad_status_from_the_worker_is_500` (99, 600).
  - `worker_oversize_frame_is_relayed_as_500` (R10 frame → 500 `brust: action response exceeds 262144 bytes`) and `json_answer_to_fetch_is_500` (`{"error":"unknown call kind fetch"}` → 500).
  - `deadline_is_504` (`never_complete`, `call_timeout_ms: 50` → 504, `timed_out_calls == 1`) and `no_workers_is_503`.
- [ ] **Step 3: Implementation** (`actions.rs`; the request body is named `incoming` so it never shadows the `body` module):
```rust
//! M3-F E3/E4: the actions subtree. Rust owns the prefix, the preflight (pipeline), the body cap and the transport; the
//! app in the worker owns routing, 404/405/422 and the response. CORS is NOT stamped here: the service_fn chokepoint
//! stamps every response (cors.rs:9-14).
pub(crate) async fn handle(s: &Server, a: &ActionsConfig, parts: &http::request::Parts,
                           incoming: Incoming, full: &str, head: bool) -> Response<ResponseBody> {
    let method = parts.method.as_str();
    if matches!(method, "CONNECT" | "TRACE" | "TRACK") {                                    // R9
        return body::resp(501, "text/plain", &[], b"not implemented".to_vec());
    }
    let ce = parts.headers.get(http::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok());
    if ce.is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity")) { return body::error_415(); }   // R2
    let fb = if method == "GET" || method == "HEAD" { None } else {                          // R4: never read
        match read_capped(incoming, a.max_body_bytes).await {
            Ok(b) if b.is_empty() => None,
            Ok(b) => Some(encode_body(header_str(&parts.headers, "content-type").as_deref().unwrap_or(""), b)),
            Err(ReadErr::TooLarge) => return body::error_413(),
            Err(ReadErr::Io) => return body::error_400(),
        }
    };
    let query = full.split_once('?').map_or("", |(_, q)| q);
    let mut pairs: Vec<(Cow<str>, Cow<str>)> = parts.headers.iter()
        .filter(|(n, _)| !body::is_framing_header(n.as_str()))
        .map(|(n, v)| (Cow::Borrowed(n.as_str()), String::from_utf8_lossy(v.as_bytes()))).collect();
    if !parts.headers.contains_key(http::header::HOST) && let Some(au) = parts.uri.authority() {
        pairs.push((Cow::Borrowed("host"), Cow::Owned(au.as_str().to_owned())));             // R8 (HTTP/2)
    }
    let req = FetchRequest { method, url: full, headers: pairs, body: fb,
        req: crate::routing::routes::build_request_envelope(method, full, query, &parts.headers, None) };
    let r = call_worker_fetch(&s.pool, s.claim_timeout, s.call_timeout, &req).await;
    if !matches!(r, Err(CallError::NoWorkers | CallError::Timeout)) { s.worker_calls.incr(); }  // R11
    let resp = match r {
        Ok(f) => response_from_fetch(f),
        Err(e @ (CallError::NoWorkers | CallError::Timeout)) => body::error_503(&e.to_string()),
        Err(CallError::Deadline) => { s.timed_out_calls.fetch_add(1, Ordering::Relaxed); body::error_504("call deadline exceeded") }
        Err(e) => { tracing::error!(path = full, error = %e, "action call failed"); body::error_500() }
    };
    tracing::debug!(target: "brust::request", path = full, status = resp.status().as_u16(), "action");
    if head { crate::pipeline::head_only(resp) } else { resp }
}
```
  - Helpers in `actions.rs`:
    - `read_capped<B: http_body::Body<Data = Bytes>>(b, cap) -> Result<Bytes, ReadErr>`: `size_hint().lower() > cap` → `TooLarge`, then `Limited::new(b, cap).collect()`. An error whose `downcast_ref::<LengthLimitError>()` hits → `TooLarge`, else `Io`. Generic so a unit test can feed a `StreamBody`.
    - `encode_body(ct, b) -> FetchBody` (R2): the lowercased `ct.split(';').next().trim()` is `""`, `application/json` or `application/x-www-form-urlencoded`, or ends with `+json`, or starts with `text/`. If that holds AND `from_utf8(&b).is_ok()` → `Text`; else `B64(b64(&b))`.
    - `b64(&[u8]) -> String`: standard alphabet, `=` padding. Unit test: the RFC 4648 §10 vectors (`""`, `Zg==`, `Zm8=`, `Zm9v`, `Zm9vYg==`, `Zm9vYmE=`, `Zm9vYmFy`) + `[0,1,255]` → `AAH/`.
    - `response_from_fetch(f)` (R9): a status outside `200..=599` → `error!` + `error_500()`. Otherwise a `HeaderMap` of every non-framing pair (`HeaderName::from_bytes` + `HeaderValue::from_str`; a failure → `warn!` + skip), then `body::resp_with(status, hm, f.body)`.
  - `pipeline.rs::handle`: `let (parts, incoming) = req.into_parts();`. After the preflight block (:93), before `let head`:
```rust
    // ----- actions (M3-F E3): the whole prefix subtree, any method, before the method gate and the
    // `/_brust/` static root (the default prefix lives under it). The body is read ONLY here.
    if let Some(a) = &s.actions && a.is_under(path_only) {
        return crate::actions::handle(&s, a, &parts, incoming, full, method == "HEAD").await;
    }
```
    The HEAD tail (:142-151) becomes `pub(crate) fn head_only(resp) -> Response<ResponseBody>`, called from both places with the same bytes. On every other path `incoming` is dropped unread, as `_body` was. `lib.rs`: `mod actions;`.
- [ ] **Step 4:** `cargo test -p brust-server --test actions` (alone ×3), full `cargo test -p brust-server`, `bun run build:debug`, IDENTICAL ×4, gates. Commit `feat(server): actions branch before the method gate — prefix subtree to one fetch call, body cap, encoding (M3-F E3, E4)`.

### Task B4: CORS parity (no `cors.rs` change)

**Files:** `crates/brust-server/tests/actions.rs` (additions).

- [ ] **Step 1: Tests.** Policy (0.1.x `tests/cors.integration.test.ts`): `{ origins: ["http://allowed.test"], credentials: true, expose_headers: ["x-render-ms"] }`. The responder answers 200 `{"id":"n-2"}`.
  - `cors_preflight_on_the_action_path_is_204`: OPTIONS `/_brust/action/notes` + Origin + ACRM `POST` + ACRH `content-type` → 204.
    - Headers: ACAO = origin, ACAM ∋ POST, ACAC `true`, ACAH `content-type`, max-age `600`.
    - Vary tokens exactly `[origin, access-control-request-method, access-control-request-headers]`.
    - `fetch_count() == 0`.
  - `cors_action_post_is_stamped` (ACAO, ACAC `true`, ACEH `x-render-ms`, Vary ∋ origin) and `cors_disallowed_origin_is_processed_without_acao` (200, no ACAO/ACAC, Vary ∋ origin).
  - `cors_page_get_is_stamped` (GET `/` + Origin → ACAO) and `cors_static_vary_merges` (GET `/_brust/client/runtime-8b1c.js` → Vary ⊇ {accept-encoding, origin}).
  - `cors_options_without_preflight_headers` and `cors_disallowed_preflight`: under the prefix → forwarded, no ACAO (R3); on `/` → 405, no ACAO (the 0.1.x cases on a page path).
  - `cors_worker_acao_wins`: a responder ACAO `https://x` is kept (insert-if-absent). The `credentials + '*'` boot error is B1's test.
- [ ] **Step 2:** These pass with no code change (F2). If any fails, STOP and report: the chokepoint misses the actions path. Never stamp in `actions.rs`.
- [ ] **Step 3:** Gates. Commit `test(server): CORS parity for actions and pages through the chokepoint (M3-F E3)`.

### Task B5: `__BRUST_ACTION_PREFIX__` script (A4)

**Files:** `crates/brust-server/src/render.rs`, `src/pipeline.rs` (:31, :712), `tests/render.rs`, `tests/actions.rs`.

- [ ] **Step 1: Failing tests** (`TAG = "<script>globalThis.__BRUST_ACTION_PREFIX__=\"/api\"</script>"`).
  - `tests/render.rs`:
    - `prefix_tag_sits_before_the_store_tags`: chain `appLayout_a1, detailPage_c3`, store `{"a":{"v":2}}`, `Some(TAG)` → the output ends with `TAG<script type="application/json" data-brust-store="a">{"v":2}</script><script type="module" src="/_brust/client/runtime-8b1c.js"></script><script type="module" src="/_brust/client/detailPage_c3-1a2b3c.js"></script></body></html>`. With no store, `TAG` sits right before the runtime tag.
    - `static_chain_gets_no_prefix_tag` (R12: `appLayout_a1, homePage_b2` → output `==` input).
    - `none_is_byte_identical` (`prefix_tag = None` `==` `inject_page_assets_into` for every fixture chain × store None/Some).
    - The existing tests stay unmodified.
  - `tests/actions.rs`:
    - `non_default_prefix_page_gets_the_tag`: prefix `/api` → `/pokemon/pikachu` holds `TAG` once, right before `<script type="module" src="/_brust/client/runtime-`. The next GET is a HIT with identical bytes.
    - `default_prefix_adds_no_tag` (`ActionsConfig::default()` vs `boot(fake())`: `?nocache=1` bodies `==`).
    - `api_prefix_routes_actions` (POST `/api/x` → fetch; POST `/_brust/action/x` → 405).
- [ ] **Step 2: Implementation** (`render.rs`):
```rust
/// [`inject_document_assets_into`] without a prefix tag (the store lane's behaviour, byte for byte).
pub fn inject_page_assets_into(html: &mut String, chain: &[String], m: &Manifest, store: Option<&Node>) {
    inject_document_assets_into(html, chain, m, store, None);
}
/// M3-F A4: as [`inject_page_assets_into`], with `prefix_tag` (the server's prebuilt `__BRUST_ACTION_PREFIX__`
/// script, only for a non-default prefix) first: `[prefix tag][store tags][runtime]…`; nothing for a static chain (R12).
pub fn inject_document_assets_into(html: &mut String, chain: &[String], m: &Manifest,
                                   store: Option<&Node>, prefix_tag: Option<&str>) {
    // today's body of inject_page_assets_into, with `if let Some(t) = prefix_tag { tags.push_str(t); }` before the store tags
}
```
  - `pipeline.rs:712` → `inject_document_assets_into(&mut out, &route.chain, &s.manifest, ctx.get(STORE_KEY), s.action_prefix_tag.as_deref());` (and the import at :31).
- [ ] **Step 3:** `cargo test -p brust-server`, `cargo bench -p brust-server --bench render --no-run`, `bun run build:debug`, IDENTICAL ×4 + `grep -c __BRUST_ACTION_PREFIX__` → 0, gates. Commit `feat(server): __BRUST_ACTION_PREFIX__ script before the store tags for a non-default prefix (M3-F A4, E6)`.

### Task B6: napi `StartOptions.cors` / `.actions`

**Files:** `crates/brust-napi/src/server.rs`, `packages/brust/src/native.ts`.

- [ ] **Step 1: Failing tests** (`server.rs` `mod tests`, pure fns, no napi host):
  - `cors_options_map_onto_cors_config`: `credentials: None` → `false`; `headers`/`max_age_seconds` copied.
  - `actions_options_default`: `{ prefix: None, max_body_bytes: None }` → `ActionsConfig::default()`; `/api` and 1024 are copied.
- [ ] **Step 2: Implementation.**
```rust
/// Global CORS (0.1.x `NapiCorsOptions`, brust/src/lib.rs:79-98); napi camelCases the keys:
/// `origins, methods, headers, exposeHeaders, credentials, maxAgeSeconds`. Validated by `start` (`cors: …`).
#[napi(object)]
pub struct NapiCorsOptions {
    pub origins: Vec<String>,
    pub methods: Option<Vec<String>>,
    pub headers: Option<Vec<String>>,
    pub expose_headers: Option<Vec<String>>,
    pub credentials: Option<bool>,
    pub max_age_seconds: Option<u32>,
}
/// M3-F A3 consumer `{ prefix?, maxBodyBytes? }` (defaults `/_brust/action`, 262144). Present = actions on.
#[napi(object)]
pub struct NapiActionsOptions { pub prefix: Option<String>, pub max_body_bytes: Option<u32> }

fn cors_config(c: NapiCorsOptions) -> CorsConfig { /* field for field; credentials.unwrap_or(false) */ }
fn actions_config(a: NapiActionsOptions) -> ActionsConfig {
    ActionsConfig {
        prefix: a.prefix.unwrap_or_else(|| DEFAULT_ACTION_PREFIX.into()),
        max_body_bytes: a.max_body_bytes.map_or(DEFAULT_MAX_ACTION_BODY_BYTES, |n| n as usize),
    }
}
```
  - `StartOptions` gains `pub cors: Option<NapiCorsOptions>, pub actions: Option<NapiActionsOptions>`.
  - The `Config` literal (:124) gains `cors: opts.cors.map(cors_config), actions: opts.actions.map(actions_config),`. The doc lists `cors: …` and `actions: …` boot errors.
  - `native.ts`: export `CorsOptions` and `ActionsOptions` (keys as in "Interfaces"), add `StartOptions.cors?` and `.actions?`, and widen the `WorkerFn` kind to `'loader' | 'jobs' | 'fetch'`.
- [ ] **Step 3:**
  - `cargo test -p brust-napi`.
  - `cd packages/brust && bun run build:debug && grep -n "cors?\|actions?\|maxBodyBytes\|exposeHeaders" native/index.d.ts` (paste the output).
  - `bun run typecheck`; `bun test test/napi-server.test.ts` (unchanged).
  - Commit `feat(napi): StartOptions.cors and .actions; fetch call kind (M3-F A3)`.

### Task B7: Worker transport — `actions-bridge.ts` + the `fetch` branch

**Files:** Create `packages/brust/src/actions-bridge.ts`, `packages/brust/test/actions-bridge.test.ts`. Modify `packages/brust/src/worker.ts` (one import, :265-268).

- [ ] **Step 1: Failing tests** (`view = new Uint8Array(new SharedArrayBuffer(SLOT_BYTES * 2))`, 2 slots).
  - `writeFramed/readFramed round trip`: status 201, two pairs, body 0..255 in slot 1 → equal; slot 0 untouched (all zero).
  - `toRequest`:
    - body: `{text}` → `req.text()` equal and no invented `content-type`; `{b64:'AAH/'}` → `[0,1,255]`; `null` → `req.body === null`; GET with a body → dropped, no throw.
    - origin: host `ex.com:8080` → `http://ex.com:8080/_brust/action/t?x=1`; host `a b` or missing → `http://localhost/…` (R8).
    - headers: two `x-dup` pairs → `'a, b'`.
  - `runFetch` via `setActionsApp({ fetch })`:
    - echo; meta keys exactly `status`, `headers` (no `store`).
    - `two Set-Cookie survive`: `append('set-cookie','a=1')`, `'b=2'` → both pairs, in order.
    - `fetch runs in a store scope`: `getServerInstance('s', mk)` inside the app → 200; at the test top level it throws `/outside a request scope/`.
    - `two interleaved fetches see their own scope` (20 ms / 1 ms; each reads back its own id).
    - `oversize body → 500 frame` (R10): a `SLOT_BYTES` body with 1 slot → 500 `brust: action response exceeds 262144 bytes`, and one `console.error` matching `/exceeds the 262144-byte slot/`.
    - Failures, each a 500 frame: `no app` → `brust: actions are not configured in this worker`; `app throws` → `brust: action failed`; unparsable JSON → 500 frame.
    - `setActionsApp({})` throws `TypeError` `/fetch/`.
  - `makeDispatch(h, view, 1)('fetch', json, 0)` → bytes decode as a frame (sane `meta_len`), and `h.loader`/`h.jobs` are never called.
- [ ] **Step 2: Implementation** (`actions-bridge.ts`; `ActionsManifest`, `ActionsApp`, `setActionsApp`, `getActionsApp` exactly as in "Interfaces"):
```ts
// The worker side of the `fetch` call kind (design E4/E5, contracts A1/A2). Rust forwards the actions prefix subtree
// here; the app registered with `setActionsApp` (Elysia 2 via brust() — m3f-actions-elysia) answers a web Request
// with a web Response, framed into this worker's SAB slot.
import type { LoaderReq } from './routes'
import { runInStoreContext } from './store/server-context'

export interface FetchRequest { method: string; url: string; headers: [string, string][]; body: { text: string } | { b64: string } | null; req: LoaderReq }
export interface FetchMeta { status: number; headers: [string, string][] }
let app: ActionsApp | null = null
export function setActionsApp(a: ActionsApp | null): void {
  if (a !== null && typeof (a as { fetch?: unknown }).fetch !== 'function') throw new TypeError('setActionsApp: the actions app has no fetch(request) function')
  app = a
}
export function getActionsApp(): ActionsApp | null { return app }

const enc = new TextEncoder()
const HOST = /^[A-Za-z0-9.\-:[\]]+$/
/** A1 → web Request (R8 origin). Bytes, never a string body, so no content-type is invented. */
export function toRequest(r: FetchRequest): Request {
  const host = r.headers.find(([k]) => k === 'host')?.[1]
  const origin = `http://${host && HOST.test(host) ? host : 'localhost'}`
  const bodyless = r.method === 'GET' || r.method === 'HEAD'
  const body = bodyless || !r.body ? undefined : 'text' in r.body ? enc.encode(r.body.text) : Buffer.from(r.body.b64, 'base64')
  return new Request(origin + r.url, { method: r.method, headers: r.headers, body })
}
/** A2 writer at `slot`'s sub-region; returns the byte length. A frame that does not fit becomes R10's 500 (always fits). */
export function writeFramed(view: Uint8Array, slot: number, slots: number, status: number, headers: [string, string][], body: Uint8Array): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  const meta = enc.encode(JSON.stringify({ status, headers }))
  const total = 4 + meta.length + body.length
  if (total <= sub) return put(dst, meta, body)
  console.error(`[brust] action response ${total} bytes exceeds the ${sub}-byte slot (F82) — answered 500`)
  const m = enc.encode(JSON.stringify({ status: 500, headers: [['content-type', 'text/plain; charset=utf-8']] }))
  const b = enc.encode(`brust: action response exceeds ${sub} bytes`)
  return 4 + m.length + b.length > sub ? 0 : put(dst, m, b) // 0 → Rust BadResponse → 500
}
function put(dst: Uint8Array, meta: Uint8Array, body: Uint8Array): number {
  new DataView(dst.buffer, dst.byteOffset, 4).setUint32(0, meta.length, true)
  dst.set(meta, 4)
  dst.set(body, 4 + meta.length)
  return 4 + meta.length + body.length
}
/** The A2 reader (tests; mirrors Rust `decode_fetch_frame`). */
export function readFramed(view: Uint8Array, slot: number, slots: number, len: number): { meta: FetchMeta; body: Uint8Array } { /* … */ }
const fail = (view: Uint8Array, slot: number, slots: number, msg: string) =>
  writeFramed(view, slot, slots, 500, [['content-type', 'text/plain; charset=utf-8']], enc.encode(msg))

/** The `fetch` call (makeDispatch). Never rejects, never writes JSON: every outcome is a frame. */
export async function runFetch(requestJson: string, view: Uint8Array, slot: number, slots: number): Promise<number> {
  const a = app
  if (!a) return fail(view, slot, slots, 'brust: actions are not configured in this worker')
  try {
    const req = toRequest(JSON.parse(requestJson) as FetchRequest)
    // R1/E5: one store scope around the handler AND the body read (a lazy body may still touch stores).
    const out = await runInStoreContext(async () => {
      const res = await a.fetch(req)
      const pairs: [string, string][] = []
      res.headers.forEach((v, k) => { if (k !== 'set-cookie') pairs.push([k, v]) })
      for (const c of res.headers.getSetCookie()) pairs.push(['set-cookie', c])
      return { status: res.status, pairs, body: new Uint8Array(await res.arrayBuffer()) }
    })
    return writeFramed(view, slot, slots, out.status, out.pairs, out.body)
  } catch (e) {
    console.error(`[brust] action failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return fail(view, slot, slots, 'brust: action failed')
  }
}
```
  - `worker.ts`: `import { runFetch } from './actions-bridge'`. The FIRST statement of the fn `makeDispatch` returns: `if (kind === 'fetch') return runFetch(requestJson, view, slot, slots)`. `startWorker` is NOT touched (the elysia lane calls `setActionsApp` there).
- [ ] **Step 3:**
  - `cd packages/brust && bun run typecheck && bun test test/actions-bridge.test.ts` ×5.
  - `bun test test/worker.test.ts test/worker-store.test.ts` (unmodified).
  - IDENTICAL ×4.
  - Commit `feat(core): worker fetch transport — setActionsApp, web Request in a store scope, framed Response (M3-F E4, E5)`.

### Task B8: napi end-to-end + CI

**Files:** Create `packages/brust/test/actions-napi.test.ts`. Modify `.github/workflows/ci.yml` (:120, + one line after :126).

- [ ] **Step 1: Test** (own file, one `startServer`, like `napi-server.test.ts`).
  - First, the boot errors: `startServer({ …, cors: { origins: ['*'], credentials: true } })` throws `/cors: .*wildcard/`, and `actions: { prefix: '/_brust' }` throws `/actions: .*reserved/`. A failed boot leaves the current server untouched.
  - Boot: `startServer({ host: '127.0.0.1', port: 0, distDir: <fixture dist>, workers: 1, claimTimeoutMs: 500, actions: { prefix: '/api', maxBodyBytes: 1024 }, cors: { origins: ['http://allowed.test'], credentials: true } })`.
  - Then `setActionsApp({ fetch })` (a 10-line router on `new URL(req.url).pathname`).
  - Then `registerWorker(view, 2, makeDispatch(h, view, 2))`, where `h: Handlers` is a hand `{ loader, jobs }` returning the fixture data of `napi-server.test.ts:9-34`.
  - Cases:
    - `POST /api/team` → 201, JSON echoed, ACAO stamped;
    - `binary body and two cookies through Rust` (bytes 0..255 byte-equal; `getSetCookie().length === 2`);
    - 1025 bytes → 413, app not called;
    - preflight 204;
    - GET `/pokemon/pikachu` holds `<script>globalThis.__BRUST_ACTION_PREFIX__="/api"</script>` once;
    - POST `/_brust/action/x` → 405;
    - a 300 KiB answer → 500 `brust: action response exceeds 262144 bytes`;
    - the app's `getServerInstance` → 200.
  - End with `await beginDrain(2000)`.
- [ ] **Step 2: CI.** Append `test/actions-bridge.test.ts` to the `:120` list. Add `- run: cd packages/brust && bun test test/actions-napi.test.ts` after `:126`. `cargo test --workspace` (:42) already runs `tests/actions.rs`.
- [ ] **Step 3:** `bun run build:debug && bun test test/actions-napi.test.ts` alone ×3, full `bun test`, gates. Commit `test(core): actions through the real Rust server and worker dispatch (M3-F)`.

### Task B9: Perf sanity, snapshots, READY

- [ ] **Step 1:** `$OUT/snap.sh b9 && $OUT/cmp.sh before b9` → `IDENTICAL` ×4; `grep -c __BRUST_ACTION_PREFIX__ $OUT/body-b9-*` → 0 each.
- [ ] **Step 2: Perf sanity.** The hot-path deltas: one `Option` check in `handle`, the decode closure, one `Option<&str>` in the injection.
  - Copy `/private/tmp/claude-501/-Users-detoro-code-brust/f9f1ca9f-9960-401d-990c-64a7577cb7d5/scratchpad/m3pe/abproto.ts` to `$OUT`.
  - Clone the lane (`cp -cR <lane> $OUT/tree && rm -rf $OUT/tree/.git`). Put release builds `before.node` (lane base) and `after.node` (HEAD) in `$OUT/addons/`, and confirm both sides' `worker.ts` differ.
  - Run `BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3f-actions-bridge <agent>' AB_VARIANTS=before,after AB_PROBES=S,D,I AB_ROUNDS=3 bun $OUT/abproto.ts` (two-layer `bench:host-lock`, interleaved, alternating order).
  - Acceptance: paired median rps ≥ −1% on S, D and I. Below that, STOP and post the numbers (Risk K6). Do not tune.
- [ ] **Step 3:** All gates, then READY:
```
READY lane/m3f-actions-bridge @ <sha> (base m3f @ 03fed3f or <sha after merge>)
rulings applied: R1 … R12 (as ruled)
rust: ActionsConfig + validation; actions branch before the method gate (body read only there); Fetch* wire types;
      CallKind::Fetch "fetch"; call_worker_decoded + call_worker_fetch + decode_fetch_frame; prefix tag before the store tags
napi: StartOptions.cors (NapiCorsOptions) + .actions (NapiActionsOptions); kind_str(Fetch)
ts: actions-bridge.ts (setActionsApp/getActionsApp, toRequest, writeFramed, runFetch in a store scope); makeDispatch fetch branch; native.ts
interfaces for m3f-actions-elysia: ActionsManifest, ActionsApp, setActionsApp (startWorker), startServer({actions, cors}) (run.ts) — unchanged / delta: <…>
tests: tests/actions.rs <n> · tests/render.rs +<n> · protocol/dispatch/config units +<n> · brust-napi +<n> · actions-bridge <n> (×5) · actions-napi <n> (alone ×3)
byte-identical: IDENTICAL ×4 after B3/B5/B6/B7/B9; __BRUST_ACTION_PREFIX__ in default bodies: 0; job_keys_are_pinned unchanged
perf A/B (3 rounds, paired median): S …% D …% I …% (CPU µs/req … → …)
gates: <paste>
```

## Risk ledger

| # | risk | where | mitigation / stop rule |
|---|---|---|---|
| K1 | Framed body read after the claim drops → another request overwrote the slot | `dispatch.rs` (F3) | Decode runs inside `call_worker_decoded` before `drop(claim)`; `Bytes::copy_from_slice`. Review Focus 3 |
| K2 | Chunked upload buffered unbounded | `actions.rs` | `Limited` + size-hint pre-check; `chunked_body_over_cap_is_413` |
| K3 | A page route starts awaiting its body (slowloris / hang) | `pipeline.rs::handle` | Body moves only into the actions branch; `page_route_never_reads_the_body` |
| K4 | CORS stamped twice or baked into something shared | `actions.rs` | Never stamp in the branch (cors.rs:9-14); actions never L1; B4 STOP rule |
| K5 | A worker without the fetch branch (older build) answers JSON | F10 | `meta_len` sanity → `BadResponse` 500 + log; `json_answer_to_fetch_is_500` |
| K6 | The decode refactor or extra `Option` checks cost rps on S/D/I | dispatch/pipeline/render | B9 A/B; STOP below −1%. Lead options: (a) accept and record in `bench/ATTRIBUTION.md`; (b) keep a separate non-generic JSON path in `call_worker_planned` |
| K7 | `Headers` iteration combines `Set-Cookie` | `runFetch` | `getSetCookie()` explicitly; `set-cookie` skipped in `forEach`; TS + Rust two-cookie tests |
| K8 | A string body makes `Request` invent `content-type: text/plain;charset=UTF-8` | `toRequest` | Always bytes; the test asserts no invented header |
| K9 | The prefix shadows a page or a reserved root | `ActionsConfig::validate` | R7 boot errors naming the route |
| K10 | The elysia lane needs another hook shape | interface | The "Interfaces" section is the contract; a different need is a `task challenge` before B7 merges |
| K11 | Port flakes when server-starting files run together | `actions-napi.test.ts`, `tests/actions.rs` | Run alone; separate CI line |
| K12 | Stale `.node` after a Rust edit → green lies | napi addon | `bun run build:debug` after every Rust task |
| K13 | A response over 256 KiB truncated silently | `writeFramed` | Explicit 500 with the documented text (R10, F82); Review Focus 6 |
