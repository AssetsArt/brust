# AI Production Opt-In Fix Review

Date: 2026-07-20

Reviewed commit: `0c055fcafface89bd9197425f8f807f1f42774ab`

Plan reviewed: `ai-production-opt-in-fix` task record, which names
`docs/superpowers/reports/2026-07-20-ai-build-opt-in-diagnosis.md`.

## Intent

The fix should make an unflagged production `brustjs build` honor a statically
provable `brust.run({ ai: true })`, wire that one build decision into every AI
producer, and keep AI production output separate from dev-client output.

The smaller alternative was to always emit `islands/ai.js` or to let runtime
`opts.ai` repair the build after boot. Both fail the recorded contract: always
emitting adds production cost to disabled builds, and runtime repair cannot bake
ahead-of-time native or Markdown tags. A static entry detector plus existing
producer wiring is the smallest approach that closes the producer/consumer split.

## Findings

No material findings.

## Trace

- Entry detection: `runtime/cli/ai-opt-in.ts:7` builds a no-resolve TypeScript
  program for the entry, records only named `brust` imports from `brustjs` at
  `runtime/cli/ai-opt-in.ts:23`, and only accepts `.run()` calls whose receiver
  resolves to that imported symbol at `runtime/cli/ai-opt-in.ts:44`. The object
  literal check at `runtime/cli/ai-opt-in.ts:73` rejects spreads and uses the
  final effective literal `ai` property, so unrelated `.run`, shadowing, strings,
  helper objects, and non-literal values stay out of the implicit production
  opt-in.
- Build decision: `runtime/cli/build.ts:256` verifies the entry exists before
  detection, then `runtime/cli/build.ts:261` computes the single decision as
  CLI `--ai`, build-process `BRUST_AI=1`, or the static entry detector. That
  value is passed to Markdown at `runtime/cli/build.ts:388`, gates island/AI
  runtime output at `runtime/cli/build.ts:420`, reaches native emission through
  `process.env.BRUST_AI` at `runtime/cli/native-routes-emit.ts:993`, and is
  persisted into the prebuilt bundle banner at `runtime/cli/build.ts:576`.
- Runtime consumption: prebuilt boot still computes AI from `dev`, `opts.ai`, or
  `BRUST_AI` at `runtime/index.ts:515`, registers AI internal routes at
  `runtime/index.ts:535`, and serves the runtime from `<dist>/islands/ai.js` at
  `runtime/index.ts:532`. After the fix, the producer for that file runs before
  the consumer can advertise it.
- Native AI/dev isolation: `injectDevClientIntoTemplate` now injects only the dev
  client at `runtime/cli/native-routes-emit.ts:264`. Native emission applies
  `BRUST_DEV` and `BRUST_AI` independently at
  `runtime/cli/native-routes-emit.ts:993`, reusing `injectAiScriptIntoTemplate`
  from `runtime/generator.ts:25`, whose document-only behavior preserves native
  fragment output.
- Test coverage: `runtime/cli/ai-opt-in.test.ts:21` covers named import,
  renamed import, shadowing, spreads, unrelated calls, non-literals, and duplicate
  `ai` properties. `runtime/cli/native-routes-emit.test.ts:777` guards that
  production AI does not make the dev helper inject the AI tag. The real CLI
  regression at `tests/ai-build.test.ts:84` builds and boots a literal
  `ai: true` app without `--ai`, proving `ai.js`, banner, native HTML tag,
  AI routes, no dev route, and production cache headers; the disabled control at
  `tests/ai-build.test.ts:142` proves zero AI/dev output.

## Verification

- `bun test runtime/cli/ai-opt-in.test.ts` passed: 6 pass, 0 fail.
- Initial `bun test tests/ai-build.test.ts` failed because this review lane had
  no `node_modules`, matching the recorded lane dependency gotcha; after adding
  the ignored `node_modules` symlink and running `bun run build:debug`, it
  passed: 2 pass, 0 fail.
- Initial full native emitter run stalled before the changed tests with the stale
  ignored native addon. After `bun run build:debug`, `bun test
  runtime/cli/native-routes-emit.test.ts` passed: 57 pass, 0 fail.

## Residual Risk

`runBuild` still mutates process-wide `BRUST_AI` at `runtime/cli/build.ts:262`.
That is acceptable for the public `brust build` CLI path, which dispatches one
build per process at `runtime/cli/index.ts:41`, and the process-level regression
tests spawn clean environments. It would become a defect only for an unsupported
in-process multi-build caller.

## Verdict

Ship. The commit matches the recorded plan and closes the diagnosed
producer/consumer split without reintroducing native dev-client leakage.
