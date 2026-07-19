# Hot reload syntax-crash minimization

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Minimize the reliable syntax-error Bun segfault from the reproduction audit and identify the failing subsystem boundary. Investigation only; do not edit production or committed tests.

## Reading order

1. `docs/superpowers/reports/2026-07-19-hot-reload-repro.md` § syntax failure
2. `runtime/dev/coordinator.ts` and its wiring in `runtime/index.ts`
3. `runtime/islands/build.ts`, `runtime/cli/native-routes-emit.ts`, `runtime/dev/jinja-reload.ts`, `runtime/dev/worker-registry.ts`
4. Relevant compiler/NAPI entry points and git history

## Work

Use disposable fixtures and fresh ports. Reproduce the baseline twice, then flip one axis at a time to isolate whether the crash requires: invalid syntax in `routes.tsx` versus a leaf page/island; `buildIslands`; native template re-emission; worker termination/spawn; native routes; multiple workers; or the dev coordinator at all. Prefer direct CLI/function probes for each subsystem. Capture stderr and process exit status. Attach a debugger or obtain a backtrace if the environment supports it; otherwise name the last completed boundary from tagged external observations without adding persistent instrumentation.

Generate 3–5 ranked hypotheses and run the cleanest disproof first. A Bun runtime bug is not an actionable Brust root cause until the Brust call/order that triggers it is minimized. Recommend a containment boundary even if the underlying Bun crash cannot be fixed in this repo.

## Deliverable

Write `docs/superpowers/reports/2026-07-19-hot-reload-syntax-crash-diagnosis.md` with exact repro, minimization table, fail path, disproof ledger, root-cause confidence, and regression-test seam. No production/test edits.

## Gate

At least two matching runs of the minimized repro plus one control that does not crash. Record exact Bun/runtime version.
