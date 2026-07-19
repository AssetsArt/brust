# Hot reload server fail-path trace

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Trace watcher → coalescing/classification → coordinator → rebuild/re-emission → worker restart → broadcast end to end, and identify falsifiable race, invalidation, and recovery defects. Investigation only; do not edit production or tests.

## Reading order

1. `architecture.md` sections covering dev/runtime workers
2. `runtime/dev/watcher.ts`, `runtime/dev/coordinator.ts`, `runtime/dev/worker-registry.ts`, `runtime/dev/ws-channel.ts`, `runtime/dev/jinja-reload.ts`
3. Wiring in `runtime/index.ts`, `runtime/cli/dev.ts`, `runtime/cli/native-routes-emit.ts`, `runtime/islands/build.ts`
4. All colocated tests plus `tests/dev-reload*.test.ts`
5. Relevant git history for those paths

## Work

Enumerate every state, queue/drop decision, async boundary, cache/invalidation target, and failure/recovery branch. Pay special attention to changes arriving while `Coordinator.state === 'building'`, dominant-kind coalescing, partial build side effects, worker termination before a failing spawn, watcher semantics for create/delete/rename, stale native/island artifacts, and whether an error leaves the next edit recoverable.

Produce 3–5 ranked hypotheses. For each: symptom explained end to end, prediction, simplest disproof, and evidence from code or an executable probe. Cross-reference each hypothesis against the reproduction report if available; do not label a code smell as a confirmed bug without a repro.

## Deliverable

Write `docs/superpowers/reports/2026-07-19-hot-reload-server-trace.md` with a compact call/state diagram, knob list, ranked hypotheses, confirmed defects, disproof results, and exact source lines. Task note must name the report path and one-line conclusion.

## Gate

Run the focused unit tests for every server module named in a confirmed claim. No production/test edits.
