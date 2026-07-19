# Brust hot-reload reliability release plan

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Release the integrated dev hot-reload reliability work as `0.1.66-alpha` under the repository release contract in `.claude/skills/release/SKILL.md`.

Human authorization: after verification is green, push the work, open and merge the PR, bump the version, tag on `main`, publish, and watch the release to completion.

## Fixed decisions

- Current shipped git tag and npm versions are `0.1.65-alpha`; the next alpha version is `0.1.66-alpha`.
- Never tag the feature branch. The annotated `v0.1.66-alpha` tag must point to the version-bump commit on updated local `main` after the green PR merges.
- `release.yml` does not gate on CI, so Aoki is the release gate: no merge before PR CI is fully green and no tag before the local/main checks below are green.
- Use `bun scripts/release-bump.ts 0.1.66-alpha`; never hand-edit the 15 version references.
- Watch `release.yml` through success and verify both `brustjs` and `create-brustjs` expose `0.1.66-alpha` on the `alpha` and `latest` npm dist-tags.

## Pre-PR gates

Run exactly from a clean checkout:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --workspace --locked
cargo test --workspace --locked
bun run ci
cd runtime && bun run build:debug
bun test runtime/
for f in native-island native-island-ssr cli-new integration; do bun test tests/$f.test.ts; done
```

Armin must also complete the read-only adversarial review of integrated main `48f1f28..6502d772` against the hot-reload reliability plan, with no open task challenges.

## Publish sequence

1. Create and push `fix/hot-reload-reliability` at the verified integrated commit.
2. Open a PR to `main`; wait for every required check to pass.
3. Merge the PR using repository convention and update local `main` from `origin/main`.
4. Run `bun scripts/release-bump.ts 0.1.66-alpha`, inspect all version changes, and commit `chore(release): 0.1.66-alpha` on `main`.
5. Create annotated tag `v0.1.66-alpha` on that main commit; push main, then push the tag.
6. Watch the resulting `release.yml` run with `--exit-status`.
7. Verify git tag/commit identity and npm package versions/dist-tags.

## Stop conditions

- Any local gate, PR check, release matrix leg, publish job, or npm verification failure stops forward progress and is diagnosed before retry.
- Do not publish a different version, force-push shared history, or bypass checks without a new recorded ruling.
