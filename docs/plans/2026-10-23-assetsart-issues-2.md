# Issues filed by Cloud by Assets Art, round 2 (B-6 to B-8): plan

owner: Detoro (22499151) · authority: in-loop · coordinator: Aitthi (eee4366f)

Source: `/Users/detoro/code/assets-art-cloud/docs/brust-issues.md` on their main e703a53 (read-only: `git -C /Users/detoro/code/assets-art-cloud show e703a53:docs/brust-issues.md`). Filed against alpha.20; they are moving to alpha.21 and will say if any no longer reproduces. Their lead is `ed1e9f68-dd52-43f8-83f0-3451d2b0f053`; only the brust lead talks to them. Round 1 plan (global constraints apply unchanged here): `docs/plans/2026-10-23-assetsart-issues.md`.

## Global constraints

Everything in the round 1 plan's Global constraints and Amendments applies (reproduce first, fail closed with a named fallback, never edit their repo, READY shape, and: any change to response bytes also runs root `bun run server-test` and the CF pokedex e2e where workerd runs). Base `origin/main`.

## Ledger rows

| row | issue | summary |
|---|---|---|
| F406 | B-6 | Native component: a `.map` inside a `.map` row loses its inner list on the client (inner rows get `x-text` but no `x-for`): empty text, rows copied into the next outer row, first-paint mismatch. HIGH, wrong output. |
| F407 | B-7 | A static component under a condition that holds a lucide icon fails the build with `nested-instance ... has a job` though it has no job. Valid React as a build error. |
| F408 | B-8 | JSX whitespace that contains a line break, before (or after) a NATIVE component, is kept as text; React's JSX rule drops it. Cosmetic wrong output. |

## Decisions (settled)

- **F406.** The inner `.map` is a client list too: an `x-for` scoped to the outer row, keyed by the inner `key`, with the outer row's item in scope; server HTML and client must agree with no first-paint mismatch. If a complete fix is not possible in the lane, refuse the shape by name (React island), never wrong output. Tests: the filed repro served (`main.innerHTML` after load == React, no `[brust] first-paint mismatch` warning, click switches the visible tab == React), plus an inner keyed reorder and an inner list that reads the outer item.
- **F407.** Reduce first: copy their repo at commit 3f28136 (lane `assetsart-blog`) READ-ONLY into your scratchpad (`git -C /Users/detoro/code/assets-art-cloud archive 3f28136 | tar -x -C <scratch>`), apply the filed TryBadge edit there, and bisect to a minimal repro inside brust's tests. Then: a lucide icon that compiles to a static SVG is not a job; and wherever `nested-instance` is reached for a real job under a document root, it must be a named fallback or a precise error naming the job and its source line, never `0:0` with no cause. Tests: the reduced repro builds and paints == React.
- **F408.** Apply JSX's whitespace rule (as Babel/React: text lines are trimmed; whitespace containing a line break at the start or end of a line is removed; lines joined by one space) to the text next to a native component boundary exactly as it is applied next to a static element. Tests: the filed repro's static HTML == React `renderToString`; text after a native component on its own line; two native components on consecutive lines; a same-line space before a native component is KEPT (React keeps it).

## Task table

| slug | rows | tier | role | deps | acceptance |
|---|---|---|---|---|---|
| aac-nested-list | F406 | complex | implementer (suggested: Guetta) | - | red-then-green served test from the B-6 repro; `cargo test -p brust-compiler --no-fail-fast`; runtime-dom tests + `bun scripts/size.ts --check` if the runtime changes; battery + shadcn `--check`; served `tests/server` files one at a time. review: complex |
| aac-icon-under-cond | F407 | standard | implementer (suggested: Dew, before F288 phase B) | - | reduced repro test (red before); `cargo test -p brust-compiler --no-fail-fast`; battery + shadcn `--check`; the filed in-repo repro builds in the scratch copy |
| aac-jsx-whitespace | F408 | standard | implementer (suggested: Dew after F407, or the first idle senior) | - | the four whitespace tests (red before where React differs); `cargo test -p brust-compiler --no-fail-fast` (expect golden churn: every changed golden named in the READY with why); battery + shadcn `--check`; served tests one at a time |

## Release and reply

Ships in the alpha after these merge (alpha.22 carries B-5 and does not wait for them). Then `conclave tell ed1e9f68…` one line per issue with the fixing version (bb `rule:assetsart-notify`).
