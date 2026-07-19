# Hot reload island-staleness minimization

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Explain why an island source edit produces `building → reload → ok` while the emitted client chunk remains stale. Investigation only; do not edit production or committed tests.

## Reading order

1. `docs/superpowers/reports/2026-07-19-hot-reload-repro.md` § island staleness
2. `runtime/islands/build.ts` and its tests
3. route/island discovery and the `buildIslands` closure wired in `runtime/index.ts`
4. generated `.brust` manifests/chunks and relevant git history

## Work

Reproduce twice in disposable fixtures, then trace source path → discovered island entry → build input → output hash/content → served URL. Compare a fresh-process build after the same edit with the hot-reload build. Flip one variable at a time: initial discovery snapshot versus rescan, source import/cache state, generated virtual entry content, Bun.build entrypoints, output-directory replacement, and manifest/chunk URL selection. Hash source, build input, emitted chunk and served response each run.

Produce 3–5 ranked, falsifiable hypotheses and run disproofs. Distinguish a stale emitted artifact from a fresh artifact served under a stale URL/manifest. Identify the smallest correct integration-test seam that proves browser-loaded island behavior changes, not merely that a reload frame arrived.

## Deliverable

Write `docs/superpowers/reports/2026-07-19-hot-reload-island-staleness-diagnosis.md` with the fail path, hash ledger, confirmed root cause, disproofs, and regression-test seam. No production/test edits.

## Gate

At least two matching hot-reload failures, one fresh-build control, and focused existing island build tests recorded.
