# Dev-loop incremental native-template compile — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R14 (NICE-TO-HAVE): every file edit = full respawn (workers + compile); feedback loop slows as the repo grows.

## Scope decision (deliberately bounded)

The dev reload pipeline (coordinator) is `clearIslandCache → buildIslands → reEmitJinja → terminateAll → spawnAll → reload` with hard-won ordering invariants (md re-splice is wired INSIDE buildIslands; jinja must reload before worker spawn; the islands dir is rebuilt in three places). **We do NOT touch the step structure.** The bounded win: `emitNativeTemplates` recompiles EVERY native route through jsx-rustc on EVERY ts edit — make that incremental with a content-hash memo. Worker respawn stays (documented as the remaining fixed cost — it's correctness-load-bearing: per-isolate caches).

## Goal

`emitNativeTemplates` skips recompiling a route whose source — including every TRANSITIVELY imported local file — is unchanged since the last emit in this dev session.

## Non-goals

- Skipping coordinator steps per change kind; partial worker restarts; island-chunk incrementality (Bun.build is already fast); persistence of the memo across dev restarts (in-memory only).

## Design

In `runtime/cli/native-routes-emit.ts` (or a small sibling module):

- Per dev-session memo: `Map<templateName, { hash: string, outputs: string[] }>`.
- Hash inputs per route: the route component source + ALL transitively imported local sources — reuse the EXISTING transitive import walker (`scanImports`-based BFS used by the css route-deps pipeline; find and reuse, do not re-implement) + the lucide/directive/component-source env that feeds compileJsx (anything that changes the compiler INPUT must be in the hash: component_sources map contents, directiveNames, lucide icon set — hash the resolved inputs actually passed to compileJsx, which is the robust formulation: hash WHAT GOES IN).
- Hit → skip compileJsx AND skip rewriting the .jinja/.islands.json/.components.json/.factory.ts sidecars (they're on disk from the previous emit; the function must still report the template name in its returned manifest list).
- Miss/first-run/scan-error → compile as today and update the memo. ANY error in hashing/scanning falls back to compile (never trade correctness).
- Only active when invoked from the dev path: gate on an opts flag (`incremental: true` passed by dev.ts's reEmitJinja callback) so `brust build` stays full-fidelity.
- Log a one-liner: `[brust] dev: native templates — N compiled, M unchanged (skipped)`.

## Tests

- Unit (native-routes-emit.test.ts exists — extend): two consecutive emits with unchanged sources → second emit performs 0 compiles (spy/counter via the opts seam or by timing-independent assertion on a returned stats object — ADD a `{ compiled, skipped }` return for testability); edit the route file → recompiles; edit a transitively-imported component → recompiles THAT route; scan failure → falls back to compile-all.
- Existing emit tests green unchanged (default path = no memo).
- tests/dev-reload.test.ts regression green.

## Acceptance criteria

Full `bun test` + biome green; the unit tests above; honest docs note (architecture.md dev-loop section): compile side incremental, worker respawn remains per change.
