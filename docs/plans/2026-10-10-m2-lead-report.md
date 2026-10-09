# M2 lead report — 2026-10-10

Outcome report for the human from the lead (Detoro). Every ruling below is also on the Conclave task record it names (or in the spec amendment block it names); the spec, the plans and the ledger are the canonical documents. Numbers come from `bench/RESULTS.md`, `docs/plans/m2-exit-report.md`, the ledger and the task records; anything I could not trace to a source is marked "(not verified)".

## Headline

**M2 = the server end to end, shipped on `v2`.** Branch `v2` is at `3ed8bc4` (14 lane merges, PRs #119–#132; the M1 base was `720e6d7`). `brust build && brust start` serves the trimmed `examples/pokedex` from `dist/manifest.json`:

| Route | Leaf tier | Chain | Cache |
|---|---|---|---|
| `/` | native | appLayout → homePage | — |
| `/pokedex` | static | appLayout → browsePage | — |
| `/pokemon/{name}` | native | appLayout → detailPage | L1 60 s, tag `pokemon`, bypass `query(nocache)` |
| `/type-chart` | static | appLayout → typeChart | L1 3600 s, tag `types` |
| `*` | static | notFoundPage (own `<html>`, 0 Bun calls, no scripts) | — |

14 compiled components (7 static, 6 native, 1 react), 6 job records (2 ssr), 7 inlined child instance records, 2 `useId` slots. Gates at the m2e merge: `tests/server/pokedex.test.ts` 8 pass, `tests/server/hydrate.chromium.test.ts` 1 pass (Playwright Chromium: the TeamBuilder island hydrates with no console error and is interactive), `scripts/m2-exit` 5 pass, `release.yml` `workflow_dispatch` run 37937111429 success (6 native builds + `bun publish --dry-run`; the publish job skipped by design). CI jobs on every merged PR: `rust`, `runtime-dom`, `battery`, `browser`, `server`.

**The bench bar is NOT met on probes B and C.** Bar (S14 + S10 amendment): v2 not slower than 0.1.x on any probe, `Accept-Encoding: identity` on both sides; gzip columns are an extra. `oha -c 120 -z 10s`, Bun 1.4.2, darwin/arm64, release addon, 6 workers, 10 cores; the 0.1.x side is `example/pokedex` from `main` @d04718f.

| Probe | Path | identity: m2e as filed (F68) | identity: m2e merged report | identity: after m2p (PR #132) | gzip after m2p (v2 / 0.1.x rps) |
|---|---|---:|---:|---:|---:|
| A static hit | `/type-chart` | −48.9 % | 3,040 vs 4,822 (−37 %) | **46,865 vs 5,113 (+816.6 %)**, p50 2.53 vs 23.42 ms | 110,206 / 4,969 |
| B native miss | `/pokemon/{name}?nocache=1` | −71.7 % | 23,771 vs 43,871 (−45.8 %) | **41,086 vs 53,087 (−22.6 %)**, p50 2.80 vs 1.97 ms | 40,948 / 52,489 |
| C react child | `/` | −78.0 % | 17,907 vs 47,296 (−62.1 %) | **33,737 vs 51,449 (−34.4 %)**, p50 3.39 vs 2.04 ms | 27,934 / 51,369 |

The "as filed" column is knock2's first m2e run (v2 gzipping every dynamic response, before ruling 7b51afc5 made identity the bar); the middle column is the identity re-measure that merged with m2e; the right columns are the m2p lane at `36d856f`. Load average at the m2p run start was 6.73 on 10 cores (`bench/run.ts` refuses a run above the core count). macOS numbers are not Linux numbers.

Measured causes of the remaining B/C gap (ledger F68 as re-filed on the m2p lane, `bench/attribution.ts`, before the last fixes): CPU per request v2 B 233 µs / C 299 µs vs 0.1.x 133 / 136 µs. v2 renders minijinja on the tokio threads (B ~65 µs, C ~100 µs single-threaded: `json_attr`, the allocator, `Value` ordering in `BTreeMap` maps) while 0.1.x renders on its Bun threads; the loader round trip costs ~45–50 µs (tsfn bridge ~16, Rust serde parse of the loader JSON ~11–14); the L1 get contends from 8 threads (2.7 µs vs 147 ns single-threaded). Levers measured but not done: a string-keyed map instead of minijinja's `BTreeMap<Value,Value>` (5–11 % of render), parsing the loader response straight into a render `Value`, batching the loader and jobs calls (protocol change: M3 spec), the same sharded read front for L1.

**M2 closes with that documented gap by the lead's ruling.** Ledger F68 (perf lane): "m2p-render-perf → re-filed for M3 with this gap by lead ruling fa75bfe8 (3); M2 closes with the documented gap in the lead report". The ruling's step 2 (attribute CPU per stage before any further change) and step 3 (re-file with a measured cause if the bar is still not met) are cited by the implementer's task notes and commit `e8765f2`; the ruling text itself is not an event on the task record (it was a tell) (not verified beyond those citations). This supersedes the earlier ruling on challenge 7ad720e5 ("M2 is not complete until F68 closes with the bar met"), which the m2e exit report still prints verbatim; the generated report's bench paragraph on PR #132 still reads "M2 is not complete: the bar is not met", because `scripts/m2-exit` prints that line whenever the bar is not met — the ledger row is the authoritative state.

## What shipped (branch `v2`, HEAD `3ed8bc4`)

| Lane | PR | Implementer | Review (reviewer, rounds) | Merge | What |
|---|---|---|---|---|---|
| m1-gate-hardening | #119 | knock2 | Mellow, 1 | `b7e3869` | Exit gates prove what the M1 exit report claims (`--emit all` in the battery, dual-eval fails without `bun`, browser harness captures `console.error`); ledger F43–F49 |
| m2d-island-hydration | #120 | Tiësto | Afrojack, 1 | `da797cc` | `@brust/runtime-dom` `island.ts`: `<brust-island>` registry, idle hydration, `data-hydrated="1"`; build budget 13 → 14 KB |
| m2a-compiler | #121 | knock2 | Mellow, 3 (round 3 lead-authorised, scoped) | `61af3c0` | Outlet intrinsic, island host + `x-props`, `useId` from `_idN`, `instances[]`, jobs `outputs`; F32–F35, F37, F39–F42, F49 |
| m2b-server-port | #122 | Dew | Mellow, 2 | `dba91da` | `crates/brust-server`: manifest, L1 + job cache (moka, tags), loader/jobs dispatch, render + outlet composition, asset injection; 253 tests |
| m2a2-ssr-props | #123 | Tiësto | Afrojack, 1; lead spot-check by Mellow REVIEW-FAIL after merge → m2a3 | `c7345ee` | `JobDecl.props` map on child ssr jobs (`[idx]` for the row); `cache()` from `@brust/brust` |
| m2c-napi-package | #124 | Dew | Mellow, 4 (rounds 3–4 lead-authorised) | `56135ad` | `crates/brust-napi` + `@brust/brust`: `defineRoutes`, worker, `brust build`/`start`, manifest writer, bundles, e2e, CI `server` job |
| m2a3-ssr-literals | #125 | Tiësto | Afrojack, 1 | `8ac1fcb` | `JobDecl.literals`; a react child under nested lists is the compile Error `nested-instance` |
| m2x-minijinja-3 | #126 | knock2 | Mellow, 1 | `ca4d98c` | minijinja 2.24 → 3.0: `value_of` helper, semantic probe, JS-faithful `%`/`/` filters; dual-eval unchanged |
| m2c2-rename-core | #127 | Tiësto | Afrojack, 1 (+ gate conflict ruled, no fix round) | `20dc422` | Package `@brust/brust` → `@brust/core`; `@brust/core/routes`; specifiers, fixtures, CI |
| m2b2-call-deadline | #128 | knock2 | Afrojack, 1 (+ re-review after the v2 merge) | `b69f01b` | Per-call deadline: 504 to the client, SAB claim held until JS settles; `BRUST_CALL_TIMEOUT_MS` (F64) |
| m2e-pokedex-exit | #129 | knock2 | Mellow, 2 | `5adf780` | Trimmed pokedex (offline snapshot), server e2e + Chromium, bench vs 0.1.x, generated exit report, `release.yml` dry run, `release-bump.ts` |
| m2a4-guarded-slots | #130 | Tiësto | Afrojack, 1 | `5a14e2f` | Precompute returns every slot (`null` under a false guard); the server treats a missing slot as undefined with one warning (F67) |
| m2c3-child-chunks | #131 | Dew | Afrojack, 1 | `ba10a0f` | Every chunk-bearing native child gets a static `children[]` entry on the chain component, so its chunk is linked (F66) |
| m2p-render-perf | #132 | Dew | Mellow, 1 (her bench: A +874 %, B −31.6 %, C −33.1 %; output byte-identical) | `3ed8bc4` | Cached rendered body + lazy gzip on L1 HIT, gzip level 1 above 16 KiB, `_props` view, outlet without copies, tokio I/O threads = cores, `BRUST_WORKER_THREADS`, renderSlots `min(cores,16)`, byte-scan `e` filter, one-pass `json_attr`, boot-built job plan templates, sharded job-cache read front; criterion micro-bench; F68 re-filed |

Implementers: Dew (Implementer, Complex), knock2 (Standard), Tiësto (Routine). Reviewers: Mellow (Complex), Afrojack (Standard). Gates: Illenium. Coordinator: Aitthi.

## Rulings

Each bullet: challenge/note id, who raised it, the decision, where it is recorded. Ids without a `ruling` event on the task record are recorded only in the spec/plan/ledger block named (the tell was copied there).

**Contracts (manifest, spec S6 amendment block)**

- f4649e5d — Mellow. React-tier SSR wire form: a react CHILD is not a child record; its `ssr` job lives in the parent's `jobs[]` as the IR emits it (`outputs[]`, `target`, `per_instance`); `children[]` is for inlined native/static children with jobs. Spec S6 amendment; the compiler is the source of truth.
- 22411f50 — Dew. `children[].instances` has ONE wire form, the string `"static" | "per-row:<list path>"`; `k` is never on the wire (derived from order on both sides); the object form of an earlier amendment is withdrawn. Spec S6.
- eea156b0 — Dew. `client_only` react components get no ssr job record; the host paints empty; the server never asks Bun to render a window-reading component. Spec S6.
- 01d6722a — Mellow (m2b review, probe `M_cochild`): a `client_only` react child never mounted end to end (no parent→child link, no chunk injected). Ruled 1e64b3e9: m2c writes a `components` record (with `client`) for every react-tier component including `client_only` children, plus a parent `children[]` entry `{id, instances:"static", props:{}}`; m2b unchanged. Spec S6 @cb57464; m2c plan Task 6. Credit Mellow.
- 05c677eb — Mellow (lead spot-check of m2a2 after merge, REVIEW-FAIL): a react child inside nested lists compiled to a 2-D `_ssr_` slot the server cannot serve (islands paint empty, no diagnostic); literal props mapped to `null` = build error. Ruled 773dd04c: (1) compile Error `nested-instance`; (2) literals are NOT a build error — `JobDecl.literals`, worker merges them over the server-built inputs, server unchanged. Fix lane m2a3-ssr-literals; spec S6 @fef44a5; F60 for computed props (M3). Credit Mellow.
- `"*"` in `inputs` = all of the component's props (loader context for a chain entry, `child_props` for a child instance); per-component overlays so two chain components numbering `_s1` do not collide; scoped `cache({key})`. Spec S6 (rulings cb881050 + b5b84a3d cited by the m2b READY note; texts not on the record) (not verified beyond the spec text).

**Semantics**

- a76cefb2 — Mellow. `useId` context keys are 0-based (`_id0` is the first `useId()`); the id VALUE may keep a 1-based suffix. Spec S7 step 6; m2b plan.
- d687ca5 — Mellow (m2a review round 1, findings 5 and 8). M2 supports ONE level of per-row child instances; deeper nesting is the compile Error `nested-instance`; n-dimensional instance arrays are M3 (F53). Spec S6.
- `outlet-in-react` (compile Error) and `outlet-outside-layout` (build error, raised by m2c from `uses_outlet` + the route tree, since the compiler cannot see the route tree). Spec S8 amendment; map contract 5 and 9 ("an IR-only pass is never a build").
- `client_only` islands use `createRoot(host).render(...)`, never `hydrateRoot`; `identifierPrefix` = the island's component id on both `renderToString` and `hydrateRoot`; a worker exit or unhandled rejection in `brust start` is fatal (drain, exit non-zero). Spec S12 amendments (a)–(c), rulings on Mellow's m2c review.
- F66 — Mellow (m2e review, found by `hydrate.chromium.test.ts`): an inlined native child with a chunk but no job/`useId` was never linked, so its click handler never mounted. Ruled: the build flattens a static `children[]` entry for every chunk-bearing native descendant onto the chain component. Spec S6; lane m2c3-child-chunks.
- F67 — Mellow (m2e review): a job slot under a false guard returned `undefined`, JSON dropped the key, the server answered 500 (`/pokemon/nothing`). Ruled: precompute returns every slot, `null` under a false guard; the server treats a missing slot as undefined with one warning. Spec S6; lane m2a4-guarded-slots.
- 33ea30d7 — Tiësto (m2d). The 13 KB runtime-dom budget cannot hold `island.ts` (+1,361 B). Ruled e4db762f: the figure is a bloat guard, not a spec decision; raise to 14 KB in its own commit; no lazy-chunk split; plan Verification amended. Credit Tiësto.

**Process**

- Review-cap rounds: m2a round 3 (scoped to the v2 merge diff + `array_source_ok`) and m2c rounds 3–4 (scoped to item (c)) were lead-authorised beyond the 2-round cap; recorded in the Coordinator's milestone-done and MERGE-READY notes on those tasks.
- Gate conflict on m2c2 — raised by Illenium (GATES-RED 552372dc: the plan's grep required 0 `@brust/brust` hits, 2 were deliberate negative tests). Ruled 1b40fe91: the plan was wrong, not the lane; plan amended on v2 @b144577; the gate is treated green at 9b54816, no fix round. Credit Illenium ("caught it, took no claim, made no edits").
- 74c8d37d — Dew (m2c3). The generated exit report changed (6 → 7 inlined child records) outside the lane's boundary. Ruled 5899d0e6: boundary extended to the unedited output of `bun run m2-exit`; the change is evidence the fix works (dexCard under browsePage was a second dead child). Credit Dew.
- m2b2 HOLD — the lead superseded an existing REVIEW-PASS/GATES-OK at `e444ea7` when PR #128 conflicted with v2 after the rename; review and gates re-ran on the merged sha `7d02094` only.
- Plan-bug credit rule used throughout: a plan defect is owned by the lead and the finder is credited on the ruling (Tiësto, Mellow, Illenium, Dew above).
- m2a2 spot-check: a Standard-reviewed lane whose output is a cross-lane contract got a Complex spot-check after merge (lead note 9b3df728); it failed and was fixed in a follow-on lane rather than reverted.

**Perf**

- 7ad720e5 — knock2 (m2e bench challenge). S10 amendment: an L1 entry MAY carry the rendered document (HTML bytes and, lazily, their gzip) and a HIT serves it without re-rendering (the render is a pure function of templates, context, manifest); dynamic responses gzip at level 1 only above 16 KiB; the bar is measured with `Accept-Encoding: identity` on both sides, gzip as an extra column; perf work lives in lane m2p-render-perf (F68). Spec S10; ledger F68.
- 7b51afc5 — ruled on m2e GATES-RED 4c18ef74: `bench/run.ts` measures every probe identity (bar) + gzip (extra); `exit.test.ts` accepts "not met" only while F68 is open AND its owner names `m2p-render-perf` (negative control: F68 DONE without "met" fails). Recorded in the m2e READY/REVIEW notes and `scripts/m2-exit`.
- c3a1e8cc — Mellow (m2e REVIEW-FAIL). Ruled 2c223d7e (v2 @836bebf): implement 7b51afc5 exactly; `release.yml` publish job runs only on `push` of `refs/tags/v*` with `environment: npm-publish`, fails unless tag == `v<packages/brust version>` and HEAD is on `origin/v2`, tarball checks re-run before publish; F66/F67 are M2 scope in parallel lanes; the exit report's Integration paragraph must be computed; `MAY_BE_REFILED` must name a plan/lane; the Chromium mismatch fixture is a committed negative test.
- 7d164bb6 — the lead (m2p). Per-stage request attribution harness (`bench/attribution.ts`, commit 40283bc) before further changes; ruled on Dew's corrected challenge ed9f28b5 (tokio thread cap was the first bottleneck).
- 7804f50e — Dew (m2p). v2 defaulted `renderSlots` to 1 per worker vs 0.1.x `min(cores,16)`; loader claim wait 2.5–2.9 ms under load. Ruled 7ffa9b19: default `min(availableParallelism, 16)` (cap 64), SAB per worker = 256 KiB × slots documented in the README; boundary extended to that line, its test and the README. Credit Dew.
- fa75bfe8 — the lead (m2p). `BRUST_WORKER_THREADS` knob for the HTTP runtime (commit 3151a83); `crates/brust-jinja` added to the m2p boundary; step 2 attribute, step 3 re-file F68 with the measured gap if the bar is still not met — applied in commit e8765f2 and the F68 row. Text not on the record (not verified beyond those citations).

## Human decisions in M2

- Scope: M2 = the server end to end on v2 (`brust build && brust start` serving the pokedex), spec S1–S14 approved 2026-10-09; npm publish as a CI dry run only — publishing a version is a human action (spec §0).
- S2: `crates/brust-server` is a port of 0.1.x `brust-core` (pure Rust, hyper, moka), not a rewrite.
- S4: `defineRoutes` minus `native`; unknown fields are an error.
- S12: the react tier = `renderToString` SSR + idle hydration (`requestIdleCallback`), one path, no streaming, no per-component strategy in M2.
- A separate lane for minijinja 3.0 ("แยก lane minijinja 3", approved 2026-10-09) — m2x-minijinja-3, PR #126.
- Package rename `@brust/brust` → `@brust/core` ("`@brust/core/routes` would be much better than `@brust/brust/routes`") — m2c2-rename-core, PR #127; nothing had been published under the old name.

## Reviewer bar that held

A blocker is "silently wrong output with no diagnostic"; negative controls are RUN, not read; every blocker got one pinned test. What it caught in M2, all with the REAL producer (brustc rebuilt from `origin/v2`, manifests hand-written to the current S6, `brust_server::start` booted with a fake Bun, or the real CLI):

- m2b round 1 (Mellow, 6 blocking items): layout/page `_s1` collided; a twice-used react child got one SSR; per-row react child slots were empty; `"*"` on a react page failed at boot; `_props` was not seeded; encoded/duplicate query names did not bypass L1. The server test fixture did not match the real compiler shape — fixed by rebuilding the teamBuilder fixture from real `brustc` output. All six fixed at `c5f9554` and re-probed.
- m2b round 2 extras run by the reviewer: RwLock gate stress (215k ops, 0 tagged survivors), hostile loader keys (`_ssr_*`, `__outlet`, `__own`, `_props`) never reach the page, CRLF/status clamp/HEAD length/symlink escape/header timeout.
- m2c (Mellow, 4 rounds): out-dir wipe — `brust build --out-dir` into a directory with unrelated files now exits 1 `out-dir-unsafe` and keeps the files (round 4, re-run with the real CLI); `client_only` chunks must not `hydrateRoot` an empty host (S12 b); a loader that never settles held its SAB slot forever and 503'd every later request (F64 → m2b2); `useId` repeats across instances of the same island (F63, M3). A "server-only leak" finding is attributed to this review in the brief but is not on the task record's surviving notes (not verified).
- m2a2 spot-check (Mellow): nested-list react child = silently empty islands; literal props = spurious build error — both ruled and fixed in m2a3.
- m2e (Mellow, round 1): the bench compared gzip-on-v2 against identity-on-0.1.x; `release.yml` could publish from a `workflow_dispatch` on a tag; the exit report's Integration paragraph was hand-written; F66 and F67 found through the Chromium test and `/pokemon/nothing`.
- Standard reviews (Afrojack) on routine lanes verified the plan's Review Focus items against the diff and left gates to Illenium; two of them (m2d, m2a2) were flagged as spot-check candidates and one spot-check failed (above).

## Ledger F43–F68 (owner column of `docs/plans/m1a-followups.md`)

| Id | State | Where it stands |
|---|---|---|
| F43 | open, owner M2 | dual-eval harness mirrors runtime-dom instead of running it (happy-dom run of the real runtime) |
| F44 | open, owner M2 | dual eval does not compare `x-show` or server `x-props` vs client `x-props-bind` |
| F45 | DONE | one Chromium test (`hydrate.chromium.test.ts`); the other browser cases still run on happy-dom |
| F46 | open, owner M2 | selector-based negative assertions in `tests/browser/cases` pass trivially |
| F47 | open, owner M2 | `runBattery()` builds `brustc` twice; binary resolved without `cargo metadata` |
| F48 | open, owner M2 | browser harness never un-hijacks `console.*` after a file's last case |
| F49 | DONE (m2a @2159b49) | `refused` requires the `--emit all` stderr to name the error class |
| F50 | DONE (m2a @691ceeb) | enclosing `For` sources are client reads when a link sits in the row |
| F51 | DONE (m2a) | `rows.length` seeded as the count |
| F52 | open, owner m2d / F32-b | `x-if` on a host element skipped by the parent's walk |
| F53 | open, owner M2 (fail-closed) | nested instances (grandchild in a row) are `nested-instance` Errors; n-dimensional arrays |
| F54 | M3 (rolled over) | mixed-text `<title>`/`<textarea>` emits `<span x-text>` |
| F55 | open, owner M2 | `<Outlet>` with attrs/children dropped silently; loc 0 |
| F56 | open, owner M2 | instance ordinal `k` counted in two places |
| F57 | open, owner M2 | effect-deps capture misses; F37 message wrong for an imported memo |
| F58 | open, owner M2 | state guard folded into a job; static inner list in a dynamic row; user `hidden` |
| F59 | DONE (m2c) | IR deviations noted for m2b/m2c |
| F60 | M3 | computed react-child props (`n={a + 1}`) → build error `ssr-prop-not-a-path` |
| F61 | M3 | minijinja auto-reload off; dev server hot template swap |
| F62 | M3 | JS `%`/`/` through brust filters (minijinja 3 floors `%`) |
| F63 | M3 | React `useId` repeats across instances of the same island (per-instance prefix via the job call id / `data-rid`) |
| F64 | DONE (m2b2, PR #128) | per-call deadline, 504, claim held until JS settles |
| F65 | M3 | drop the bare `brust` specifier (M1 fixtures, compiler `cache` recognition) |
| F66 | DONE (m2c3, PR #131) | chunk-bearing native children linked via static `children[]` |
| F67 | DONE (m2a4, PR #130) | guarded slots return `null`; server tolerates a missing slot |
| F68 | re-filed for M3 (PR #132, ruling fa75bfe8) | B −22.6 % / C −34.4 % with per-stage causes above |

**Lead decision (2026-10-10):** rows F43, F44, F46, F47, F48, F52, F53, F55, F56, F57, F58 roll over to M3. None of them is on the M2 exit path (test-infrastructure fidelity, diagnostics polish, fail-closed edge cases); each keeps its row and gets owner `M3` in the ledger in the commit that closes the M2 board. Verified at board close: F59 is DONE (the runtime bundle entry mounts `document.documentElement`, `packages/brust/src/build/bundle.ts:196`); F54 (mixed-text `<title>`) is NOT fixed and rolls to M3 with the others.

**What M3 inherits (named):** F63 per-instance `useId` prefix; F53 nested instances (n-dimensional instance arrays); Chromium coverage beyond the single F45 test; F68 B/C perf with the per-stage causes (minijinja render on tokio threads, loader round trip, L1 read contention) and the protocol-level lever (batch the loader and jobs calls — an M3 spec item); F65 drop the bare `brust` specifier; F60 computed child props; F61 dev-server template reload; F62 arithmetic filters; the open M2-owned rows above.

## Human actions pending

1. **Create the GitHub environment `npm-publish`** on `AssetsArt/brust` with required reviewers, and **move `BRUST_NPM_TOKEN` into it as an environment secret** (remove the repo-level copy). `release.yml` already references `environment: npm-publish` (line 77) and reads `secrets.BRUST_NPM_TOKEN` (line 117); until the environment exists with protection rules, the publish job cannot run — intended. Mellow's warning: referencing a non-existent environment makes GitHub auto-create it with NO protection rules, and a repo-level token stays readable from it — so create it before the first `v*` tag.
2. **Decide whether to tag/publish a first `@brust/*` prerelease.** Publishing is the human's call (spec §0, map wave-3 decision, memory `npm-org-brust`). The dry run succeeded (run 37937111429: `@brust/core`, `@brust/runtime-dom`, six `@brust/native-<plat>`); `scripts/release-bump.ts --release` refuses off `v2` and only tags; the publish job guards tag == `v<version>` and HEAD on `origin/v2`.
3. **Review the bench gap decision**: M2 closes with B −22.6 % and C −34.4 % documented under F68 (ruling fa75bfe8). The alternative — holding M2 open for a string-keyed render map, a direct loader-response parse and loader/jobs batching — needs an M3 protocol spec, which is why it was re-filed rather than attempted in-lane.
4. (done) PR #132 merged at `3ed8bc4`; the M2 board is closed.

## Where the records live

- Spec: `docs/design/2026-10-09-m2-server-design.md` (S1–S14; amendment blocks S6 (2026-10-09 series), S7 step 6, S8, S10, S12 a–c; §12 decisions).
- Map: `docs/plans/2026-10-09-m2-map.md` (lanes, 9 cross-lane contracts, wave-3 decisions, standing process rules).
- Plans: `docs/plans/2026-10-09-m2-{compiler,server-port,island-hydration,ssr-props,ssr-literals,napi-package,minijinja-3,rename-core,call-deadline,pokedex-exit,guarded-slots,child-chunks,render-perf}.md`, `docs/plans/2026-10-09-m1-gate-hardening.md`, `docs/design/brust-core-port.md`.
- Ledger: `docs/plans/m1a-followups.md` (F1–F68; F68 as re-filed is on the m2p lane until PR #132 merges).
- Generated reports (CI diffs them, never hand-edited): `docs/plans/m2-exit-report.md` (`bun scripts/m2-exit/run.ts`), `docs/plans/m1-exit-report.md`, `docs/react-coverage.md`.
- Bench: `bench/RESULTS.md`, `bench/RESULTS.json`, `bench/run.ts`, `bench/attribution.ts` + `bench/attribution.patch`, `crates/brust-server/benches/render.rs` (criterion).
- Release: `.github/workflows/release.yml` (dry run on `workflow_dispatch`; publish on `v*` tag push, `environment: npm-publish`), `scripts/release-bump.ts`.
- Conclave workspace `838f12fb-70c1-41b7-acf2-d4065cf6bb64`, task slugs: `m1-gate-hardening`, `m2a-compiler`, `m2b-server-port`, `m2d-island-hydration`, `m2a2-ssr-props`, `m2c-napi-package`, `m2a3-ssr-literals`, `m2x-minijinja-3`, `m2c2-rename-core`, `m2b2-call-deadline`, `m2e-pokedex-exit`, `m2a4-guarded-slots`, `m2c3-child-chunks`, `m2p-render-perf` (state `review`; all others `merged`).
- Previous report: `docs/plans/2026-10-09-m1-lead-report.md`.
