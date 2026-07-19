# Hot reload client and coverage review

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Adversarially review the browser-side dev protocol and current regression seams, then identify missing tests that permit user-visible reload failures. Investigation only; do not edit production or tests.

## Reading order

1. `runtime/dev/client.ts`, `runtime/dev/inject.ts`, `runtime/dev/ws-channel.ts`
2. HTML/native/Markdown injection call sites in `runtime/index.ts`, `runtime/cli/native-routes-emit.ts`, and related render/generator code
3. `tests/dev-reload*.test.ts`, `runtime/dev/*.test.ts`, and browser-test infrastructure/comments
4. Relevant git history and post-mortems

## Work

Trace initial connection, reconnect/backoff, building/reload/error/ok handling, CSS link replacement, duplicate clients, connection loss during server restart, and injection parity across React, native Jinja, Markdown, error pages, and SPA navigation. Verify whether current tests assert fresh DOM/content rather than protocol receipt only. Seek deterministic browser or protocol-level repros; list test seams needed for each confirmed server/client defect.

Apply outsider scrutiny: distinguish intended full reload from hot CSS update, and distinguish state-loss UX from correctness failure. For each finding cite path/line, observed or predicted user symptom, a disproof attempt, and the smallest regression-test seam.

## Deliverable

Write `docs/superpowers/reports/2026-07-19-hot-reload-client-review.md` with findings ordered by severity, confirmed vs inferred clearly separated, and a proposed test matrix. Task note must name the report path and a one-line verdict.

## Gate

Run the focused client/inject/ws-channel tests and any deterministic browser/protocol probe used as evidence. No production/test edits.
