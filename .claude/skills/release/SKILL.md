---
name: release
description: Cut a brustjs npm release (the brust framework). Use when the user asks to release, publish, cut a version, or tag a release of this project. Enforces the order PR → green CI → merge to main → tag ON MAIN (never tag a feature branch), bumps every version reference, and watches the publish.
---

# Releasing brustjs

`release.yml` publishes on a `v*` tag: `brustjs` + 6 per-platform native packages
+ `create-brustjs`, to npm. **It does NOT gate on CI** — a red `ci.yml` still
publishes. So YOU are the gate: never tag until CI is green on main.

## The order (do NOT deviate)

```
1. Push branch        → 2. Open PR (→ main)   → 3. WAIT for CI to go GREEN
→ 4. Merge PR to main → 5. Bump version on main → 6. Tag vX.Y.Z ON MAIN → push tag
→ 7. Watch release.yml to success
```

**Never tag a feature branch.** The tag must point at the merged commit on `main`.
(Past mistake: tagging `feat/*` before merge/CI — works mechanically but is wrong.)

## 1–2. Pre-flight gates + PR

Mirror `ci.yml` EXACTLY before opening the PR (so CI won't surprise you):
```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --workspace --locked && cargo test --workspace --locked
bun run ci                                   # biome
cd runtime && bun run build:debug && cd ..   # CI builds the addon before bun tests
bun test runtime/
for f in native-island native-island-ssr cli-new integration; do bun test tests/$f.test.ts; done
```
Then: `git push origin <branch>` and `gh pr create --base main --head <branch> …`.

## 3. Wait for CI — GREEN before merge

```bash
gh pr checks <pr#> --watch          # or: gh run watch <run-id> --exit-status
```
Do not proceed until every check passes. If red, fix on the branch and repeat.

## 4. Merge to main

```bash
gh pr merge <pr#> --squash --delete-branch   # or --merge, per repo convention
git checkout main && git pull origin main
```

## 5. Bump version ON MAIN — use the script (do NOT hand-edit)

Last tag = current shipped version → increment (alpha line: `0.1.N-alpha` → `0.1.(N+1)-alpha`).
`scripts/release-bump.ts` bumps **all 15 version refs atomically and VERIFIES**,
so a partial bump can't ship:
```bash
bun scripts/release-bump.ts 0.1.9-alpha    # set the NEW version
# → "✓ bumped 15/15 refs to 0.1.9-alpha"  (exits non-zero + writes nothing if any ref is missing)
git commit -am "chore(release): 0.1.9-alpha"
```
The 15 refs: root `version` + its 6 `optionalDependencies["brustjs-*"]` pins,
`create-brustjs` `version` + its `brustjs` dep pin, and the 6 `npm/*/package.json`
versions. The script tolerates a MIXED starting state (e.g. a prior partial bump)
and rewrites every ref to the target. `bun.lock` has no version ref.

> **Why a script, not `sed`:** 0.1.54 and 0.1.57 both botched by bumping ONLY the
> root `version`. The 6 per-platform packages then can't publish, npm `latest`
> never moves onto the new version, and `brustjs` optionalDeps pin the wrong
> native build. npm versions are immutable, so each botch costs a throwaway
> fix-forward release (0.1.55, 0.1.58). Never hand-edit the version refs.

## 6. Tag on main + push

```bash
git tag -a v$NEW -m "brustjs $NEW — <summary>"
git push origin main          # the bump commit
git push origin v$NEW         # ← triggers release.yml
```
Shortcut once CI is green on main: `bun scripts/release-bump.ts $NEW --release`
does the bump + `chore(release)` commit + tag + push in one step (refuses to run
off `main`). Use the explicit steps above when you want to inspect the bump first.

## 7. Watch the publish

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

## release.yml notes (footguns)

- Prerelease (version has `-`, e.g. `-alpha`) → published under the `alpha` dist-tag
  AND `latest` is force-moved onto it (both `brustjs` + `create-brustjs`), because
  npm pins `latest` to the first publish and `--tag alpha` never moves it. Stable
  (no `-`) → normal `latest`, never force-tagged.
- The 6-platform matrix cross-compiles (napi-cross + zigbuild for aarch64-musl);
  if any build leg fails, `publish` (needs: build) is skipped — no half-release.
- A Rust change only reaches users if the per-platform `.node` rebuilds — the
  matrix does this from the tagged commit, so the tag MUST be the release commit.
- `workflow_dispatch` runs the build matrix WITHOUT publishing (validate cross-compile).
