# Issues filed by Cloud by Assets Art, round 3 (B-10, B-11): plan

owner: Detoro (22499151) · authority: in-loop · coordinator: Aitthi (eee4366f)

Source: `/Users/detoro/code/assets-art-cloud/docs/brust-issues.md` on their main 9d04efe (read-only). Rounds 1 and 2 (`docs/plans/2026-10-23-assetsart-issues.md`, `docs/plans/2026-10-23-assetsart-issues-2.md`) set the global constraints; they apply unchanged, including: a change to response bytes runs root `bun run server-test` AND the CF pokedex e2e where workerd runs (name it in every task's acceptance; F413 missed it and CI caught it).

## Ledger rows

| row | issue | summary |
|---|---|---|
| F412 | B-10 | Native list with a per-row `hidden`: first-paint check against row 0 + a stray hidden row. Already fixed by F396 (alpha.21); tests pinned. |
| F413 | B-11 | `<brust-island>` takes a box, so a flex/grid gap counts it. |

## Decisions (settled)

- **F412.** The first-paint check evaluates each adopted row in its own scope; after hydration the list holds exactly the server rows. If not fixable in the lane, refuse by name (React island). Outcome: did not reproduce on main (F396 fixed the row scope in `for.ts`); the lane pins the repro as tests, red against the pre-F396 `for.ts`.
- **F413.** `style="display:contents"` on the island host at its single emit site (`lower/mod.rs` island_host), the convention of brust-host / brust-row / brust-if. Rejected: an opt-in option (the default was the bug); a global stylesheet rule (static pages may carry no brust CSS). Nothing in brust measures the island element.

## Task table

| slug | rows | tier | role | deps | acceptance |
|---|---|---|---|---|---|
| aac-list-first-paint | F412 | standard (review complex) | Dew | - | served test from the B-10 repro (no warning, innerHTML == React, click == React); runtime-dom tests + size check if the runtime changes |
| aac-island-box | F413 | routine | Guetta | - | attribute test + served island-gap test; compiler tests (goldens named); root `bun run server-test`; CF pokedex e2e (CI where workerd is missing) |

## Outcome

All shipped in 2.0.0-alpha.23 (#368, #369) together with round 2 (F406-F408, F411). Assets Art told.
