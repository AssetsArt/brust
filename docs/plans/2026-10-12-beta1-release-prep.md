# beta1-release-prep: bump every `@brust/*` to 2.0.0-alpha.1, F88 lockstep guard in release.yml, F85 drop the `dist/native` copy

**RULED by lead Detoro 2026-10-12 (plan written by the lead; all decisions below are final). This lane is the ONLY lane that goes straight to `v2` by PR (the human tags `v2.0.0-alpha.1` on the merge commit). Every other beta1 lane bases on the `beta1` integration branch. Human instruction 2026-10-12: "สร้าง npm-publish ให้แล้ว / 1. ขึ้น 2.0.0-alpha.1" — the GitHub environment `npm-publish` exists; the tag push and the environment approval stay human-only. Nobody runs `release-bump.ts --release`, `git tag`, or `bun publish` in this lane.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @79885d3 · lane: beta1-release-prep · tier: routine · review: standard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** After this lane merges into `v2`:
- All nine version refs (`packages/brust`, `packages/runtime-dom`, `packages/create-app`, `npm/<6 plats>`) read `2.0.0-alpha.1`; `bun.lock` agrees; `bun install --frozen-lockfile` passes on a clean checkout.
- `release.yml` refuses to publish unless EVERY published package's version equals the tag (F88), and the `workflow_dispatch` dry-run refuses when the nine versions disagree with each other. The check is one script, `scripts/release-check.ts`, used by both jobs and unit-tested in CI.
- `brust build` no longer writes `dist/native/` (F85). The addon is resolved at runtime through `@brust/core` → `@brust/native-<plat>` (probed by the create-app lane; nothing in `packages/` reads `dist/native` — verified by the lead with `grep -rn "dist/native" packages docs`). The scaffold e2e asserts the directory is absent after a tarball-install build.
- Ledger rows F85 and F88 in `docs/plans/m1a-followups.md` start with `DONE 2026-10-12 — …`.

## Decisions (lead rulings, final)

- **R1 Version.** `2.0.0-alpha.1` for every `@brust/*` package at once (lockstep is the policy; `scripts/release-bump.ts` enforces it, `release-check.ts` re-verifies it at publish time).
- **R2 F85 = drop the copy, not fix it.** Remove the `dist/native` copy and the `NATIVE_DIR` constant from `packages/brust/src/build/index.ts`. Rationale: the copy only ever picked `.node` files that sit next to core in the dev repo; in every real install the addon lives in `@brust/native-<plat>` and `brust start` already resolves it from there. A half-populated `dist/native` is worse than none. The M2 design doc sentence that promised the copy is amended.
- **R3 F88 = a script, not YAML loops.** `scripts/release-check.ts <version>` reads the same nine files `release-bump.ts` writes (move `PLATS` and `FILES` into `scripts/release-files.ts` and import them from both scripts) and exits 1 naming every mismatching file. `release.yml` calls it in `dry-run` (expected = core's version, so a missed ref fails a dispatch too) and in `publish` (expected = `${GITHUB_REF_NAME#v}`). `ci.yml` runs its unit test.
- **R4 `bun.lock`.** After the bump run plain `bun install` once so the lockfile's workspace entries pick up the new version, inspect the diff (only version strings of the workspace packages may change — anything else is a stop-and-challenge), commit it, and prove `bun install --frozen-lockfile` is green afterwards.
- **R5 No other changes.** No feature code, no docs beyond the two anchors below and the ledger. A defect found elsewhere is a `task challenge` with the evidence, never a patch here.

## Boundary

`scripts/release-bump.ts`, `scripts/release-files.ts` (new), `scripts/release-check.ts` (new), `scripts/release-check.test.ts` (new), `.github/workflows/release.yml`, `.github/workflows/ci.yml` (one added test command only), `packages/brust/src/build/index.ts`, `packages/create-app/test/scaffold.test.ts`, `docs/design/2026-10-09-m2-server-design.md` (line ~150 only), `docs/plans/m1a-followups.md` (rows F85, F88 only), `packages/brust/package.json`, `packages/runtime-dom/package.json`, `packages/create-app/package.json`, `npm/*/package.json`, `bun.lock`.

## Tasks

### Task 1 — lane worktree, green baseline

- [ ] `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-release-prep` (claims the task and creates the worktree). If the worktree is not created for you: `cd /Users/detoro/code/brust-v2 && git worktree add ../brust-lane-beta1-release-prep -b lane/beta1-release-prep v2`.
- [ ] In the lane worktree: `bun install --frozen-lockfile` → ends with `Checked N installs across M packages (no changes)`.
- [ ] `cd packages/brust && bun run build:debug` → exit 0 (the addon for the JS tests).
- [ ] Baseline: `cd packages/create-app && bun test test/args.test.ts test/dep.test.ts` → all pass. `grep -rn "dist/native" ../../packages ../../docs --include='*.ts' --include='*.md' | grep -v node_modules` → only `packages/brust/src/build/index.ts`, `docs/design/2026-10-09-m2-server-design.md:150`, `docs/plans/m1a-followups.md`, `docs/plans/2026-10-11-m3f-create-app.md` (plan history; leave it).

### Task 2 — F88: `scripts/release-files.ts` + `scripts/release-check.ts` + test

- [ ] Create `scripts/release-files.ts` exporting exactly what `scripts/release-bump.ts:13-15` defines today:
  ```ts
  export const PLATS = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl']
  export const FILES = ['packages/brust/package.json', 'packages/runtime-dom/package.json', 'packages/create-app/package.json', ...PLATS.map((p) => `npm/${p}/package.json`)]
  ```
  and change `release-bump.ts` to `import { FILES, PLATS } from './release-files'` (delete its local copies; `EXPECTED = FILES.length` stays 9). `bun scripts/release-bump.ts` with no arg must still print the usage line and exit 1.
- [ ] Write the test FIRST: `scripts/release-check.test.ts` — copies the nine `package.json` files from the repo into a temp dir (same relative paths), then:
  1. `bun scripts/release-check.ts <v> --root <tmp>` where `<v>` is the version in the copied `packages/brust/package.json` → exit 0, stdout `✓ 9/9 packages at <v>`.
  2. Mutate the copied `npm/linux-x64-musl/package.json` version to `0.0.1-x` → exit 1, stderr contains `npm/linux-x64-musl/package.json: 0.0.1-x (expected <v>)`.
  3. Run against the real repo root with a wrong version → exit 1 and all nine files listed.
  `bun test scripts/release-check.test.ts` → 3 fail (script missing).
- [ ] Create `scripts/release-check.ts`: args `<version> [--root <dir>]` (root defaults to the repo root `resolve(import.meta.dir, '..')`); for each of `FILES` read JSON `version`; print one `✗ <file>: <got> (expected <version>)` per mismatch to stderr; exit 1 on any mismatch or unreadable file; otherwise `✓ 9/9 packages at <version>` and exit 0. No dependencies beyond `node:fs`/`node:path`. `bun test scripts/release-check.test.ts` → 3 pass.
- [ ] `release.yml`: in job `dry-run`, right after `bun install --frozen-lockfile`, add
  ```yaml
      - name: Lockstep — every @brust/* package carries the same version (F88)
        run: bun scripts/release-check.ts "$(bun -e "console.log(require('./packages/brust/package.json').version)")"
  ```
  In job `publish`, replace the first line of the step "Guard — the tag must equal the package version…" body so the guard becomes: `bun scripts/release-check.ts "${GITHUB_REF_NAME#v}"` (fails with the file list when any package is off), then the existing `git fetch origin v2` + `merge-base` check. Keep the step name; update the comment above `environment: npm-publish` to mention the lockstep check. Note: in `publish` the guard runs BEFORE `bun install` today — move `oven-sh/setup-bun` + `bun install --frozen-lockfile` above the guard step (the script needs only Bun, not deps, but keep the order explicit).
- [ ] `ci.yml`: after line 146 (`- run: bun test scripts/m2-exit`) add a new step `- run: bun test scripts/release-check.test.ts`.
- [ ] Local proof of the YAML snippets (there is no runner): `GITHUB_REF_NAME=v9.9.9 bun scripts/release-check.ts "${GITHUB_REF_NAME#v}"` → exit 1 with nine lines; with the real version → exit 0.

### Task 3 — F85: drop the `dist/native` copy

- [ ] Write the assertion FIRST in `packages/create-app/test/scaffold.test.ts` inside the test `'blank: install → build → typecheck → start; …'` (line 56), directly after `sh(['bun', 'run', 'build'], dir)` (line 60): `expect(existsSync(join(dir, 'dist/native'))).toBe(false) // F85: the addon resolves from @brust/native-<plat>, nothing is copied`. `existsSync`/`join` are already imported (check the file header; add if not). Run `cd packages/create-app && bun test test/scaffold.test.ts -t blank` → the new assertion fails (the directory exists, possibly empty).
- [ ] `packages/brust/src/build/index.ts`: delete lines 188-191 (the `if (existsSync(NATIVE_DIR)) { … }` block), delete line 21 (`const NATIVE_DIR = …`), and drop `cpSync`/`readdirSync` from the `node:fs` import on line 7 ONLY if no other use remains (`grep -n "cpSync\|readdirSync" packages/brust/src/build/index.ts` — `cpSync` is still used at line 187 for `public/`, `readdirSync` at line 60; keep those). Also delete the doc comment on line 20. `cd packages/brust && bun run typecheck` → `No type errors`.
- [ ] `cd packages/create-app && bun test test/scaffold.test.ts -t blank` → pass. Then the full file: `bun test test/scaffold.test.ts` → all pass (pokedex + monorepo tests included).
- [ ] `docs/design/2026-10-09-m2-server-design.md` line 150: change `Copy \`public/\` and the addon (\`dist/native/brust.<plat>.node\`), write` to `Copy \`public/\` (the addon is NOT copied — \`brust start\` resolves it from \`@brust/native-<plat>\` through \`@brust/core\`; F85, 2026-10-12), write`.
- [ ] `packages/brust` tests: `cd packages/brust && bun test` → all pass (build tests must not expect `dist/native`; if one does, that expectation is the bug — fix the test and say so in the READY note).

### Task 4 — the bump

- [ ] `bun scripts/release-bump.ts 2.0.0-alpha.1` → `✓ bumped 9/9 refs to 2.0.0-alpha.1` and nine change lines. `git grep -n '"version": "0.0.0"' -- packages npm` → no output.
- [ ] `bun install` (NOT frozen) → `git diff --stat bun.lock`; `git diff bun.lock` must show only version strings of `@brust/core`, `@brust/runtime-dom`, `@brust/create-app` workspace entries (and the six natives if listed). Any other hunk → stop and `conclave task challenge` with the diff.
- [ ] `bun install --frozen-lockfile` → `(no changes)`.
- [ ] `cd packages/create-app && bun test` → all pass (dep.test.ts derives `^2.0.0-alpha.1` from the package's own version; pack.test.ts / scaffold.test.ts repack with the new version).
- [ ] `bun scripts/release-check.ts 2.0.0-alpha.1` → `✓ 9/9 packages at 2.0.0-alpha.1`.

### Task 5 — ledger, commit, READY

- [ ] `docs/plans/m1a-followups.md`: F85 cell (the 4th column, "what to do") → prefix `DONE 2026-10-12 — copy removed (build/index.ts), scaffold e2e asserts no dist/native; ` and keep the original text after it. F88 cell → prefix `DONE 2026-10-12 — scripts/release-check.ts in dry-run + publish, unit-tested in ci.yml; `. Both rows keep the leading `DONE` as the first word of that cell (the ledger parser in `scripts/m2-exit` keys on it).
- [ ] `bun run m2-exit` from the repo root → exit 0; `git status --short docs/plans/m2-exit-report.md` — if the report changed, include it (regen rule: fresh addon first, which Task 1 built).
- [ ] Commits (small, one per task is fine): `release: scripts/release-check.ts + lockstep guard in release.yml (F88)`, `build: stop copying the addon into dist/native (F85)`, `release: bump @brust/* to 2.0.0-alpha.1`, `docs: ledger F85/F88 closed`. Each ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- [ ] `conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-release-prep READY @<sha> — bump 9/9 to 2.0.0-alpha.1; release-check 3/3; create-app <n> pass; brust <n> pass; m2-exit exit 0 (report changed: yes/no); bun.lock diff = versions only`.

## Acceptance (reviewer: Afrojack, standard)

1. `git diff v2...lane/beta1-release-prep --stat` touches only the Boundary files.
2. `bun test scripts/release-check.test.ts` → 3 pass; `bun scripts/release-check.ts 2.0.0-alpha.1` → `✓ 9/9`; `bun scripts/release-check.ts 2.0.0-alpha.2` → exit 1, nine `✗` lines.
3. `release.yml`: `dry-run` and `publish` both call `release-check.ts`; `publish` still checks `merge-base --is-ancestor HEAD origin/v2`; `environment: npm-publish` unchanged; the publish order (runtime-dom → natives → core → create-app) unchanged.
4. `grep -rn "dist/native\|NATIVE_DIR" packages/brust/src` → nothing. `cd packages/create-app && bun test test/scaffold.test.ts` → pass, including the new `dist/native` absence assertion.
5. `bun install --frozen-lockfile` on the lane → `(no changes)`; `git show --stat HEAD~.. -- bun.lock` touched only by the bump commit.
6. `cd packages/brust && bun run typecheck && bun test` green; `bun run m2-exit` exit 0.

## Gates (lead, at merge — mirror of ci.yml)

Unchanged Rust → fmt/clippy/cargo test still run (fail-fast). JS: `packages/brust` build:debug + typecheck + `bun test`; runtime-dom typecheck/test; `packages/create-app` typecheck + `bun test` (scaffold e2e included); `tests/server/pokedex.test.ts`; `bun run battery` + diff; `bun run m2-exit` + diff + `bun test scripts/m2-exit scripts/release-check.test.ts`; bench lib tests + typecheck; `git apply --check bench/attribution.patch`.

## Risk ledger

- `bun.lock` may record workspace versions → the frozen install would fail on CI after the bump if the lockfile is not refreshed (Task 4). If `bun install` changes anything but versions, challenge, do not commit.
- `scaffold.test.ts` runs from PACKED tarballs: it exercises the new `dist/native` behaviour only if the pack step picks up the edited `build/index.ts` (it builds `@brust/core` from the lane tree; `test/helpers.ts` shows how). If the assertion passes BEFORE you edit `index.ts`, the test is not exercising the lane — stop and look at `helpers.ts`.
- `release-bump.ts` runs at import time (top-level script); `release-files.ts` must be a plain module with no side effects so `release-check.ts` and the test can import it.
- The ledger parser (`scripts/m2-exit`) reads `DONE` as the first word of the cell; a leading backtick or space breaks the count.

## Reporting

READY note as in Task 5. Escalations: `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-release-prep --claim <text>`; the lead rules. After merge, the HUMAN tags: `git tag v2.0.0-alpha.1 <merge-sha> && git push origin v2.0.0-alpha.1`, then approves the `npm-publish` environment run; nobody in the loop does either.
