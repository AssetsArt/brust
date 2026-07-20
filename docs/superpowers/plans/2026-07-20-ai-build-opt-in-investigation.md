# Programmatic AI production build investigation

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Reproduce and explain why an app whose entry calls `brust.run({ ai: true, ... })`
has `window.Brust` in `brustjs dev` but not after `brustjs build` followed by
`bun run ./dist/index.js`. Investigation only: do not change production or test
code in this task.

## Settled contract

- `ai: true` is a production opt-in, not only a source/dev runtime toggle. A
  prebuilt app using it must emit and serve the browser runtime, inject its
  script into React/native/Markdown documents, and expose `window.Brust`.
- Existing `brustjs build --ai` and `BRUST_AI=1 brustjs build` behavior must stay
  valid; disabled production builds must retain zero browser-runtime cost.
- Diagnosis follows reproduce → trace fail path → ranked hypotheses and disproof
  → breadcrumb reconciliation before recommending a fix.

## Reading order

1. `runtime/cli/build.ts` (`parseArgs`, `buildBanner`, `runBuild` AI decisions)
2. `runtime/index.ts` (`brust.run`, `aiEnabled`, prebuilt paths/internal routes)
3. `runtime/islands/build.ts` (AI browser chunk emission)
4. `runtime/cli/native-routes-emit.ts`, `runtime/md/emit.ts`, and
   `runtime/render/stream.ts` (document injection)
5. `README.md` AI runtime and CLI sections

## Reproduction

Create a disposable minimal app outside tracked source, with a literal
`brust.run({ routes, entry: import.meta.url, ai: true })`. Run the real CLI
without `--ai`, then boot `dist/index.js` on an unused port. Record:

- whether `dist/islands/ai.js` exists;
- status of `/_brust/ai.js` and `/_brust/ai/manifest.json`;
- whether returned document HTML includes `/_brust/ai.js`;
- the equivalent `--ai` control.

The report must give exact commands or a small reusable harness and a breadcrumb
table. If the failure is not deterministic, stop without proposing a fix.

## Deliverable

Write `docs/superpowers/reports/2026-07-20-ai-build-opt-in-diagnosis.md` with the
confirmed root cause, 3–5 ranked hypotheses and their disproofs, all relevant
producer/consumer seams, and a recommended minimal regression-test boundary.

## Gate

The report must contain a deterministic failing no-flag run and passing `--ai`
control, with no retained production/test edits. Verify with `git diff --check`.
