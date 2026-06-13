# Ship .d.ts (types condition per subpath) + catch-all docs — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R12 ("เจ็บทุกวัน") — `brustjs` exports point at raw `.ts`, so a consumer's `tsc` typechecks brust internals (~70 errors they can't fix; `skipLibCheck` only skips `.d.ts`). They exclude whole apps from their root tsconfig and grep-filter typecheck output. R8 — document the `/{*slug}` 200-catch-all pattern (their workaround is good; they asked for docs, not a change).

## Goal

Consumers' `tsc` sees **declaration files** (skippable via `skipLibCheck`, no internals typechecking) while Bun keeps executing the raw `.ts` sources unchanged.

**Feasibility verified empirically on this machine:** `tsc --emitDeclarationOnly` over the 7 export entrypoints (skipLibCheck, strict:false, noEmitOnError:false, bundler resolution, allowImportingTsExtensions) emits 75 `.d.ts` files cleanly — the repo's "tsc stack-overflows" memory applies to full typechecking, not declaration emit.

## Non-goals

- Compiling runtime to .js (Bun-first stays; `default` keeps pointing at `.ts`).
- Making the emitted declarations pass OUR strict typecheck (they are emitted with `noEmitOnError:false`; the gate is the CONSUMER experience below).
- isolatedDeclarations / API-extractor bundling.

## Design

1. **Emit config** `tsconfig.dts.json` (repo root): the probe config productionized — include the 7 entrypoints (`runtime/index.ts`, `routes.ts`, `client/index.ts`, `create.ts`, `store/index.ts`, `native/index.ts`, `navigation/index.ts`), `rootDir: runtime`, `outDir: types`, declaration+emitDeclarationOnly, skipLibCheck, strict:false, noEmitOnError:false, jsx react-jsx, module/target esnext, moduleResolution bundler, allowImportingTsExtensions. Fix the probe's `types: ["bun-types"]` reference properly (point at the real bun-types or drop if unneeded for emit).
2. **Script** `"build:dts": "tsc -p tsconfig.dts.json"` (root package.json) + `"prepack": "bun run build:dts"` so `npm pack`/publish always regenerates. Add `typescript` as a pinned devDependency (bunx-fetching at publish time is nondeterministic). `types/` is gitignored; `files` array gains `"types"`.
3. **Exports map** — each subpath becomes conditional, `types` FIRST (TS requirement):
```json
".": { "types": "./types/index.d.ts", "default": "./runtime/index.ts" },
"./routes": { "types": "./types/routes.d.ts", "default": "./runtime/routes.ts" },
…etc (client/store/native/navigation map to types/<dir>/index.d.ts)
```
4. **The napi declaration**: `runtime/index.d.ts` (napi-generated, gitignored) — the emitted `types/index.d.ts` re-exports from `./index.js`; tsc resolves that against `runtime/index.d.ts` AT EMIT TIME on the build machine (napi build runs before publish in release.yml — verify ordering: `cd runtime && bun run build` precedes `npm publish`; prepack runs at publish ⇒ napi d.ts exists). If the emitted tree references `./index.js` types in a way the CONSUMER must resolve, copy/emit the napi `.d.ts` into `types/` as well (implementer verifies what the emitted files actually reference and ships whatever makes the consumer gate pass).
5. **Consumer gate (the acceptance test)** — `tests/dts-consumer.test.ts` or a script wired into CI-able test: `npm pack` the repo → fresh tmp project (`package.json` + `tsconfig.json` with `strict: true, skipLibCheck: true`) installing the tarball → a `consumer.ts` importing from all 7 subpaths and exercising key types (`defineRoutes`, `templates`, `cache`, `httpError`, `client<Actions>`, `signal`, `renderFragment`) → `tsc --noEmit` must exit 0. This is R12's actual definition of done (published-install-tarball-test memory: dev repo masks published-install bugs). Mark the test with a generous timeout; skip in environments without npm if needed (but Bun ships npm-compatible `bun pm pack` — use whatever works; tsc runs via the pinned devDependency).
6. **release.yml**: confirm prepack fires under `npm publish` in the workflow (it does by default) and that the job has run `cd runtime && bun run build` first (it does — step order verified in the explorer report). Add `bun install` if typescript isn't present in the publish job.
7. **R8 docs**: routing/404 docs page — a "200 catch-all" subsection: `{ path: '*' }` is the 404 tier; for a wildcard page that should serve 200 (e.g. CMS slugs), use `/{*slug}` and keep `*` as the real 404. Example from the consumer's pattern.

## Tests
- The consumer gate (above) — the load-bearing one.
- `build:dts` idempotence: run twice, no error; types/ contains the 7 entry declarations at the exact paths the exports map names (a small assertion script/test).
- Existing suites untouched.

## Acceptance criteria
Consumer gate green; full `bun test` + biome green; `bun run build:dts` works from clean checkout (after napi debug build); docs updated; `npm pack` tarball contains `types/` + still boots (`published-install` smoke if cheap — at minimum assert tarball contents).

## Known limitations
- Declarations are emitted non-strict; deep internal types may degrade to `any` in places — acceptable v1 (the consumer's tsc no longer typechecks our internals at all).
- `default` still `.ts`: non-Bun consumers (node + tsx?) unsupported as before — unchanged posture.
