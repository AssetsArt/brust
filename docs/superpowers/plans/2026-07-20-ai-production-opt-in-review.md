# AI production opt-in fix review

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Adversarially review commit `0c055fcafface89bd9197425f8f807f1f42774ab`
against `docs/superpowers/plans/2026-07-20-ai-production-opt-in-fix.md` and the
diagnosis report. Review only; do not edit production or tests.

## Method

Use the scrutinize sequence: state intent, consider a smaller existing seam,
trace the actual source-entry → detector → build producers → banner/runtime
consumer path, then verify native dev/AI isolation and the tests' ability to
catch regressions. Inspect unchanged callers around the diff.

Concentrate on:

- symbol binding correctness for named and renamed `brust` imports;
- false positives from shadowing, unrelated `.run`, duplicate `ai` properties,
  strings/comments, and spreads;
- build behavior for missing/JS/TSX entries and parse diagnostics;
- mutable `BRUST_AI` leakage across sequential builds in one process;
- native full-document versus fragment behavior;
- whether the process-level tests really prove production semantics and cleanly
  terminate servers.

## Deliverable

Write `docs/superpowers/reports/2026-07-20-ai-production-opt-in-review.md` with
findings ordered by severity, each citing file/line evidence and a concrete
resolution, followed by a ship/fix-then-ship/rework verdict. If no findings,
state the end-to-end paths and edge cases actually verified.

Gate: `git diff --check HEAD^ HEAD` on the report commit.

