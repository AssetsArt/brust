# alpha2-release-prep: bump every `@brust/*` to 2.0.0-alpha.2

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Routine release-only lane from `v2` @c8bb820 (beta1 round merged). Same recipe as `docs/plans/2026-10-12-beta1-release-prep.md` Task 4 (bump + lockfile) — nothing else changes. The tag and the `npm-publish` run are human calls (the alpha.1 "publish ให้เลย" authorisation was one-time).**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @c8bb820 · lane: alpha2-release-prep · tier: routine · review: standard

**Goal.** The nine version refs read `2.0.0-alpha.2`; `bun.lock` agrees (workspace version strings only); `bun install --frozen-lockfile` green; `bun scripts/release-check.ts 2.0.0-alpha.2` → `✓ 9/9`; create-app tests green (they derive `^2.0.0-alpha.2`).

## Boundary
`packages/brust/package.json`, `packages/runtime-dom/package.json`, `packages/create-app/package.json`, `npm/*/package.json`, `bun.lock`.

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 alpha2-release-prep`; `bun install --frozen-lockfile`; `cd packages/brust && bun run build:debug`.
2. `bun scripts/release-bump.ts 2.0.0-alpha.2` → `✓ bumped 9/9 refs to 2.0.0-alpha.2`; `git grep -n '"version": "2.0.0-alpha.1"' -- packages npm` → nothing.
3. `bun install` (not frozen) → `git diff bun.lock` shows only `2.0.0-alpha.1` → `2.0.0-alpha.2` version strings (anything else: stop + task challenge); then `bun install --frozen-lockfile` → `(no changes)`.
4. `bun scripts/release-check.ts 2.0.0-alpha.2` → `✓ 9/9`; `bun test scripts/release-check.test.ts` 3 pass; `cd packages/create-app && bun test` all pass (incl. scaffold e2e from packed tarballs); `cd packages/brust && bun test` all pass.
5. Commit `release: bump @brust/* to 2.0.0-alpha.2` (+ Co-Authored-By line); `conclave task note … READY @<sha> — 9/9; bun.lock versions only; create-app <n> pass; brust <n> pass`.

## Acceptance (Afrojack)
Diff touches only the Boundary; release-check 9/9 and the wrong-version call exits 1; frozen install green; create-app + brust tests green.

## Gates (lead)
packages/brust build + typecheck + tests; runtime-dom; create-app tests; pokedex server tests; m2-exit diff; bench lib tests. Then the alpha.2 PR to v2 (together with the `beta1-ci-late-plan` test fix), CI, merge; the human tags `v2.0.0-alpha.2`.
