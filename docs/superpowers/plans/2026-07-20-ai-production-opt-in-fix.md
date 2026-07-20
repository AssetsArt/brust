# Fix programmatic AI production opt-in and native dev leakage

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Make an unflagged `brustjs build` honor the common static production opt-in
`brust.run({ ..., ai: true })`, and ensure every production AI path stays free
of dev-client code. The deterministic diagnosis is
`docs/superpowers/reports/2026-07-20-ai-build-opt-in-diagnosis.md`.

## Decisions

1. Build-time programmatic detection is static and side-effect-free. Parse the
   entry module with the TypeScript compiler API; never import or execute the
   user's entry during build.
2. Recognize a literal `ai: true` on the object literal passed to `.run()` for a
   named `brust` import from `brustjs`, including a renamed local binding. Avoid
   matching unrelated objects' `.run()` calls. Dynamic expressions, spreads,
   helpers, or values imported from elsewhere remain the explicit `--ai` /
   build-time `BRUST_AI=1` case because the build cannot prove them safely.
3. The single build decision is
   `parsed.ai || BRUST_AI === '1' || entryHasLiteralAiOptIn(entry)`. It must feed
   every existing producer: browser chunk, native/Markdown templates, and bundle
   banner. Do not create a second partially-wired flag.
4. `injectDevClientIntoTemplate` becomes dev-only, matching its name and docs.
   Native emission applies dev and AI injectors independently. Reuse
   `injectAiScriptIntoTemplate` from `runtime/generator.ts`; do not duplicate tag
   placement logic.
5. Disabled production builds retain no `ai.js` and no AI/dev tag. Existing
   `--ai`, build-time `BRUST_AI=1`, dev-default AI, cache semantics, and React
   production bundling remain unchanged.

Rejected alternatives:

- Always emitting `ai.js`: weakens the opt-in build contract and still does not
  fix ahead-of-time native/Markdown tag decisions.
- Executing the entry to capture options: runs arbitrary user boot code and may
  bind a server during build.
- Regex matching: creates false positives in comments/strings/unrelated calls
  and cannot reliably track a renamed import.

## Implementation boundary

- Add a small focused detector module and unit tests under `runtime/cli/`.
- Wire it into `runtime/cli/build.ts` before any AI-gated producer runs.
- Split native dev/AI injection in `runtime/cli/native-routes-emit.ts` and add a
  focused regression test in its existing test file.
- Add one real CLI build/runtime regression (new focused test file is preferred
  over expanding the long shared smoke suite). Its disposable app imports
  `brust` from `brustjs`, calls `run({ ai: true })`, builds without `--ai`, boots
  the dist, and proves `ai.js`, both AI routes, the document tag, and production
  semantics. Include a disabled control proving zero AI/dev client output.

## Risk ledger

- False-positive AST detection can silently add production client cost; guard an
  unrelated `.run({ ai: true })` and a non-literal AI property.
- False-negative renamed imports recreate the reported bug; test
  `import { brust as app } ... app.run({ ai: true })`.
- `process.env.BRUST_AI` is mutable across Bun tests; every focused test must
  save/restore or isolate it.
- Native full-document and fragment placement differ; AI remains document-only,
  while dev behavior for fragments must remain byte-compatible.
- Lane native tests require `bun run build:debug` before process-level boot if
  the ignored addon is stale.

## Gates

Run and watch pass:

1. focused detector unit tests;
2. focused native emitter tests;
3. focused real CLI AI build/runtime regression;
4. `bun test runtime/cli/build.test.ts runtime/md/emit.test.ts runtime/render/stream.test.ts`;
5. `bun run ci`;
6. `git diff --check`.

The task is READY only with the exact commands, exit codes, and commit SHA in
its ledger.

