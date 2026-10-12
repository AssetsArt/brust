# beta1-f87-cross-site-guard: reject cross-site mutating action requests in Rust by default, and document the actions security posture

**RULED by lead Detoro 2026-10-12 (plan written by the lead; decisions final, spec E10 added to `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` by this lane). Dispatch after `beta1-f81-l1-concurrency` is READY (same implementer).**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-f87-cross-site-guard · tier: standard · review: standard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ledger row (docs/plans/m1a-followups.md:151, F87): "`POST /team` accepts `application/x-www-form-urlencoded` bodies (Elysia parses them), so a cross-site HTML form can mutate the team; the example has no auth by design. Document the posture in docs/actions.md and show a `beforeHandle` guard; consider a brust-level default for mutating actions (JSON-only or same-origin) as a design question before beta."

**Goal.** After this lane merges into `beta1`:
- A request under the actions prefix with a method other than `GET`/`HEAD`/`OPTIONS` whose browser-declared site is foreign is answered `403` by Rust before the body is read and before the worker is called, unless the app opted out (`[actions] cross_site = "allow"`) or the request's `Origin` is allowed by `[cors]`.
- Same-origin browser requests, requests without an `Origin` header (curl, server-to-server, the Eden client from the worker), and all `GET`/`HEAD` requests behave exactly as before.
- `docs/actions.md` has a "Security posture" section; spec E10 records the rule; ledger F87 is `DONE`.

## Decisions (lead rulings, final)

- **R1 Default = reject cross-site mutations.** Brust is the HTTP server; the cheapest correct place for the check is `crates/brust-server/src/actions.rs::handle` (:19) before `read_capped` (:50). The decision function is pure and unit-tested.
- **R2 The decision**, given method `m`, headers `h`, the request authority `host` (the `Host` header as received; when `X-Forwarded-Host` is present use its first value — brust sits behind proxies), config `cross_site`, and `cors`:
  1. `m ∈ {GET, HEAD, OPTIONS}` → allow (OPTIONS is CORS preflight, handled earlier in `pipeline.rs:85-93`; reads are not CSRF targets).
  2. `cross_site == Allow` → allow.
  3. `Sec-Fetch-Site` present and equal to `cross-site` (case-insensitive) → if `Origin` is listed EXACTLY in `[cors].origins` (`CorsResolved::origin_listed`: false under a wildcard, exact string match otherwise) → allow; otherwise → **reject**.
  4. `Origin` present: parse its authority (`scheme://authority` → `authority`, lowercase; a literal `null` origin counts as foreign); `authority == host` (lowercase, compare `host[:port]` as written — do NOT normalise default ports, a mismatch there is a config problem the app should see) → allow; `cors.origin_listed(origin)` (exact match; a wildcard `*` does NOT count — CORS governs what scripts may read, a cross-site form POST carries cookies regardless) → allow; otherwise → **reject**. *(Amended 2026-10-12 by ruling on challenge 930ab0fa; was `allow_origin_value(...).is_some()`, which is `Some("*")` for every origin under a wildcard.)*
  5. Neither header → allow (non-browser client).
- **R3 Response.** `403` with `content-type: application/problem+json` and body `{"type":"about:blank","title":"CrossSiteRejected","status":403,"detail":"cross-site <METHOD> to an action is rejected; set [actions] cross_site = \"allow\", or list the exact origin in [cors].origins (a wildcard does not count)"}`; no CORS headers beyond what the service_fn chokepoint stamps (it stamps nothing for a disallowed origin). Log at `debug` target `brust::actions` with the origin and host.
- **R4 Config plumbing.** `brust.toml` `[actions] cross_site = "reject" | "allow"` (default `"reject"`; any other string is a build-time error in `packages/brust/src/build/config.ts` with the message `actions.cross_site must be "reject" or "allow"`) → `manifest.actions.crossSite` → `StartOptions.actions.cross_site: Option<String>` (`crates/brust-napi/src/server.rs:106-109`, converter :124-131) → `ActionsConfig.cross_site: CrossSite` enum (`config.rs:91-94`, `Default` = `Reject`). `ActionsConfig::validate` (:119-147) rejects nothing new (the enum cannot be invalid).
- **R5 Docs, not code, for everything else.** Content-type restrictions and auth stay the app's job: `docs/actions.md` §"Security posture" shows an Elysia `.onBeforeHandle` guard that requires `content-type: application/json` for mutations and a bearer token, with the explicit sentence that actions are public endpoints unless the app adds auth. The pokedex example gains NO auth (dogfood stays simple) — but its `actions.test.ts` gets the 403 case.

## Boundary

`crates/brust-server/src/actions.rs`, `crates/brust-server/src/config.rs` (ActionsConfig + CrossSite only), `crates/brust-napi/src/server.rs` (NapiActionsOptions + converter + its unit test at :370-390), `crates/brust-server/tests/actions.rs`, `packages/brust/src/build/config.ts`, `packages/brust/src/build/manifest.ts`, `packages/brust/src/run.ts`/`native.ts` (wherever `maxBodyBytes` is forwarded — `grep -rn maxBodyBytes packages/brust/src` lists the five files; touch only the forwarding lines), `packages/brust/test/*` (config/manifest tests), `examples/pokedex/test/actions.test.ts`, `tests/server/pokedex.test.ts`, `docs/actions.md`, `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` (new E10 only), `docs/plans/m1a-followups.md` (row F87 only).

## Tasks

### Task 1 — lane worktree, baseline

- [ ] `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f87-cross-site-guard`; `bun install --frozen-lockfile`; `cd packages/brust && bun run build:debug`.
- [ ] Baseline: `cargo test -p brust-server --test actions`, `cd packages/brust && bun test`, `bun test ../../tests/server/pokedex.test.ts`, `cd examples/pokedex && bun test test/actions.test.ts` → all green. Read `crates/brust-server/src/actions.rs:1-125`, `pipeline.rs:70-105`, `config.rs:86-150`, `crates/brust-napi/src/server.rs:95-160`, how `error_413()` builds its problem body (find the helper module `body::` — `grep -rn "fn error_413" crates/brust-server/src`), and `docs/actions.md` §8-§9.

### Task 2 — Rust: `CrossSite` + the pure decision (tests first)

- [ ] `config.rs`: `#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)] pub enum CrossSite { #[default] Reject, Allow }`; add `pub cross_site: CrossSite` to `ActionsConfig` and its `Default`. Fix every construction site (`cargo build -p brust-server` lists them; `crates/brust-napi/src/server.rs:124-131` and tests).
- [ ] `actions.rs`: `pub(crate) fn cross_site_verdict(method: &str, headers: &http::HeaderMap, cors: Option<&CorsResolved>, mode: CrossSite) -> Result<(), ()>` (use the real type `s.cors_resolved` has — read `pipeline.rs:86`; add `pub(crate) fn origin_listed(&self, origin: &HeaderValue) -> bool` to `CorsResolved` in `server/cors.rs` next to `allow_origin_value` (:86), which stays unchanged). Unit tests in the existing `#[cfg(test)] mod tests` (one per R2 branch): GET foreign Origin → Ok; POST no headers → Ok; POST `Origin: https://evil.example` + `Host: app.example` → Err; POST `Origin: https://app.example` + `Host: app.example` → Ok; POST `Origin: null` → Err; POST `Sec-Fetch-Site: cross-site` without Origin → Err; same with `mode = Allow` → Ok; POST foreign Origin that `[cors] origins` lists exactly → Ok; POST foreign Origin under `origins = ["*"]` → Err; same with `mode = Allow` → Ok; `X-Forwarded-Host: app.example` + `Host: 10.0.0.5:8080` + `Origin: https://app.example` → Ok. `cargo test -p brust-server cross_site` → red, then green.
- [ ] Wire it in `handle` (:19) right after the `CONTENT_ENCODING` check (:37-43) and before `read_capped`: on `Err` return the R3 problem (add `body::error_403_problem(detail)` next to `error_413` following its shape) and `tracing::debug!(target: "brust::actions", origin, host, "cross-site rejected")`.
- [ ] HTTP-level tests in `crates/brust-server/tests/actions.rs` (reuse its harness/fake worker): POST foreign Origin → 403 problem+json AND the fake worker saw zero fetch calls; same-origin POST → forwarded; `[actions] cross_site = allow` → forwarded; GET foreign → forwarded. `cargo test -p brust-server --test actions` → green. fmt + clippy clean.

### Task 3 — napi + TS plumbing

- [ ] `crates/brust-napi/src/server.rs`: `NapiActionsOptions.cross_site: Option<String>`; converter maps `Some("allow")` → `Allow`, anything else → `Reject`; extend the unit test at :370-390 (`set` case with `cross_site: Some("allow")`). `cargo test -p brust-napi` green; `cd packages/brust && bun run build:debug` (regenerates `index.d.ts` — commit it if it is tracked; check `git status`).
- [ ] TS, tests first: in `packages/brust/test/` find the config/manifest tests that cover `[actions] max_body_bytes` (grep `maxBodyBytes`) and add: `cross_site = "allow"` → `manifest.actions.crossSite === 'allow'`; omitted → `'reject'`; `cross_site = "maybe"` → build error `actions.cross_site must be "reject" or "allow"`. Then implement in `build/config.ts` + `build/manifest.ts` (manifest type gains `crossSite: 'reject' | 'allow'`), forward in `run.ts`/`native.ts` next to `maxBodyBytes`. `cd packages/brust && bun run typecheck && bun test` green.
- [ ] e2e: `tests/server/pokedex.test.ts` add one test: `POST /_brust/action/team` with `Origin: https://evil.example` → 403, `application/problem+json`, title `CrossSiteRejected`; the existing same-origin POST tests still pass (they send no Origin or the server's own). `examples/pokedex/test/actions.test.ts`: same 403 case through the Elysia harness it uses IF the Rust layer is in that harness (read it; if the harness calls `app.fetch` directly, Rust is not in the path — then skip and say so in the READY note).
- [ ] Scaffold templates: `packages/create-app/templates/blank/brust.toml` and the pokedex `brust.toml` are NOT edited (default reject is the right template); `cd packages/create-app && bun test test/scaffold.test.ts` must still pass (its `hello` action is a GET; the pokedex POST is same-origin via `fetch` with no Origin).

### Task 4 — docs, spec, ledger

- [ ] `docs/actions.md`: new section `## 9. Security posture` before the current `## 9. Limits` (renumber 9→10, 10→11): actions are public endpoints; what brust rejects by default (R2 in prose, with the 403 body); when to set `cross_site = "allow"` (public APIs consumed cross-origin — together with `[cors]`); the `.onBeforeHandle` example (content-type + bearer token) with the sentence that auth is the app's job. Keep the 0.1.x-vs-v2 difference explicit: 0.1.x had no such check.
- [ ] Spec `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md`: add `E10 — cross-site guard (F87, 2026-10-12)` after the last E-item with R2-R4 verbatim.
- [ ] `docs/plans/m1a-followups.md` F87 cell → prefix `DONE 2026-10-12 — Rust rejects cross-site mutations by default ([actions] cross_site), docs/actions.md §9; `.
- [ ] `bun run m2-exit` → exit 0 (report regen with the fresh addon).
- [ ] Commits: `server(actions): reject cross-site mutating requests by default (F87)`, `core: [actions] cross_site config → manifest → StartOptions`, `docs(actions): security posture + spec E10 + ledger` + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- [ ] `conclave task note … beta1-f87-cross-site-guard READY @<sha> — unit <n>, http <n>, brust tests <n>, pokedex e2e <n>; pokedex actions.test 403 case: added/skipped(why)`.

## Acceptance (Afrojack, standard)

1. Every R2 branch has a unit test; `cargo test -p brust-server cross_site` lists ≥ 9 tests.
2. HTTP test proves the worker is NOT called on a 403 (fake worker call count).
3. `[actions] cross_site = "allow"` round-trips toml → manifest → napi → `ActionsConfig` (one TS test + one napi test + one HTTP test).
4. Default unchanged for same-origin and header-less clients: `tests/server/pokedex.test.ts` and `packages/create-app` scaffold e2e green without edits to the templates.
5. `docs/actions.md` §9 present; spec E10 present; fmt/clippy clean.

## Gates (lead, at merge)

Full Rust set (fmt, clippy on 5 crates, workspace tests, release `single_roundtrip`), `packages/brust` build + typecheck + tests, `tests/server/pokedex.test.ts`, `hydrate.chromium.test.ts`, browser-test, battery, m2-exit, create-app tests, bench lib tests.

## Risk ledger

- Behind a proxy that rewrites `Host` and does not set `X-Forwarded-Host`, same-origin POSTs would be rejected. R2 step 4 uses `X-Forwarded-Host` when present; the docs section must say so and name the opt-out.
- `Origin` is sent by browsers on every POST (also same-origin) and by `fetch` from Bun? Bun's `fetch` does NOT send `Origin` unless set — the Eden client inside the worker is unaffected; the Chromium hydrate test does a same-origin POST → allowed by R2 step 4. If `hydrate.chromium.test.ts` fails, the authority comparison is wrong (port handling) — fix the comparison, not the test.
- `Sec-Fetch-Site: same-site` (sibling subdomain) is treated as allowed by design (step 3 matches only `cross-site`); document it.

## Reporting

READY note as in Task 4; challenges via `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f87-cross-site-guard --claim <text>`.
