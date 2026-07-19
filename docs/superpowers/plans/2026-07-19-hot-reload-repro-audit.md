# Hot reload reproduction audit

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Build a deterministic, agent-runnable matrix for `brust dev` hot reload before any fix is proposed. This is investigation only; do not change production or test code.

## Reading order

1. `tests/dev-reload.test.ts`
2. `tests/dev-reload-option.test.ts`
3. `runtime/dev/watcher.ts`, `runtime/dev/coordinator.ts`, `runtime/dev/client.ts`
4. `runtime/cli/dev.ts`

## Work

Use `tests/fixtures/app` and distinct unused ports. Establish the current green baseline, then keep one dev server and one `/_brust/dev` WebSocket client alive while exercising these axes separately and in short bursts: TSX page edit, island edit, `app.css`, CSS module edit with unchanged exports, CSS module edit with changed exports, HTML, Markdown where supported, file create/delete/rename, two edits during an in-flight rebuild, and a syntax/build failure followed by a correcting edit. Repeat timing-sensitive cases enough to make the rate useful.

Maintain a breadcrumb ledger: command/trigger, expected messages and rendered output, actual messages/output, repeat count, and what the run rules in or out. A reload message alone is insufficient; fetch or inspect the resulting page/chunk to prove fresh content. Record server survival and recovery after errors.

## Deliverable

Write `docs/superpowers/reports/2026-07-19-hot-reload-repro.md` containing exact runnable commands, environment/version, the matrix, reliable repros, and cases that did not reproduce. Rank symptoms by severity and reproducibility. Task note must name the report path and a one-line conclusion.

## Gate

`bun test tests/dev-reload.test.ts tests/dev-reload-option.test.ts` must be observed and recorded. Every claimed bug needs at least two matching runs or an explicit flake rate.
