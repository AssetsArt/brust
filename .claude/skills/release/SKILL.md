---
name: release
description: Publish a brust v2 version (2.0.0-alpha.N) to npm and update brust.dev. Use when the user asks to cut, tag, publish or ship a release, or after a batch of lanes has merged. Covers the order (notes PR → tag on main → release.yml → npm check → docs deploy) and the checks that prove each step.
---

# Releasing brust v2

`release.yml` publishes when a `v*` tag is pushed: `@brust/core`, `@brust/core-cf`, `@brust/runtime-dom`, `@brust/create-app`, `@brust/cache-redis`, `@brust/cache-cloudflare` and the six `@brust/native-<platform>` packages. **It does not wait for CI.** A tag on a red commit still publishes, so you are the gate.

## Who decides

- **Alpha versions** (`2.0.0-alpha.N`): the human authorised cutting them in batches as lanes land, and updating brust.dev each time. Cut one whenever main holds user-visible work that is not yet published.
- **A stable version** (no `-alpha`), or anything that changes the npm org, tokens or the domain: ask the human first.
- npm versions are immutable. A broken publish costs a new version, never a re-publish.

## Order (do not deviate)

```
0. Every lane PR of the batch is MERGED on main with green CI   (gh pr view <n> --json state == MERGED)
1. Release notes PR (skill: release-notes) → green CI → merge
2. No open PRs                                                   (gh pr list --state open → empty; main requires up-to-date)
3. On main: bun scripts/release-bump.ts 2.0.0-alpha.N --release  (bump 12 refs + commit + tag + push)
4. Watch release.yml to success
5. Verify npm: every package's dist-tag latest == the new version
6. Deploy brust.dev, then verify the live pages
7. Tell the team the version is out; reopen merges
```

Never tag a lane branch: the tag must point at the release commit on `main`.

## 1–2. Notes, then a quiet main

Write the notes with the **release-notes** skill. They ship as a normal PR (`website/` is code, so it goes lane → PR → CI). Merge it only after CI is green, and check the state:

```bash
gh pr merge <n> --merge && gh pr view <n> --json state --jq .state   # must print MERGED
gh pr list --state open --json number --jq length                    # must print 0 before step 3
```

While a release is in flight, merge nothing else. Pushing to main mid-CI makes the other PRs out of date.

## 3. Bump and tag, using the script (never hand-edit versions)

From a checkout of `main` that is up to date with `origin/main`:

```bash
git pull --rebase origin main
bun scripts/release-bump.ts 2.0.0-alpha.N --release
```

- The script rewrites all 12 version refs atomically (`scripts/release-files.ts`) and verifies them.
- Then it commits `chore(release): …`, tags `v2.0.0-alpha.N` and pushes both.
- It refuses to run off `main`.
- `bun.lock` carries the workspace versions too, and the script handles that (the alpha.3 lesson).

## 4. Watch the publish

```bash
R=$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
until gh run view $R --json status --jq .status | grep -q completed; do sleep 120; done
gh run view $R --json conclusion --jq .conclusion      # success
```

Use **one** poller, sleeping at least 120 s. Several parallel `gh run watch` loops trip GitHub's secondary rate limit.

## 5. Verify npm, from the registry API rather than `npm view` (whose cache lags)

```bash
V=2.0.0-alpha.N
for p in core core-cf runtime-dom create-app cache-redis cache-cloudflare; do
  curl -s https://registry.npmjs.org/@brust/$p | python3 -c "import json,sys;print('$p', json.load(sys.stdin)['dist-tags']['latest'])"
done   # every line must end with $V
```

- `release.yml` moves `latest` onto prereleases on purpose, because npm freezes `latest` at the first publish.
- Right after the publish, an old tag or a 404 is propagation lag: poll every 30 s for a few minutes before calling it a failure.

## 6. Deploy brust.dev

The site is built by brust itself, so it needs the native addon of this checkout:

```bash
bun install
(cd packages/brust && bun run build:debug)
(cd website && bun run deploy)          # Cloudflare Pages project brust-dev, static build
curl -s https://brust.dev/docs/release-notes | grep -c "alpha.N"     # > 0
curl -s -o /dev/null -w "%{http_code}\n" https://brust.dev/docs/<any page the release changed>
```

A 404 right after deploy can be edge propagation, so re-check after a minute. Never touch the separate `brust-docs` project or its domain.

## Pitfalls already paid for

- **Cleanup after a merge:** chain every cleanup step with `&&` after the waiter, never `;`. A red CI must not delete a worktree or branch, because deleting the head branch closes an open PR.
- **A piped command hides the exit code:** `gh pr merge … | tail` reports success even when the merge failed, so check the state separately.
- **Red CI on a PR that does not touch the failing area:** read `gh run view <id> --log-failed`; if it is a known timing flake, run `gh run rerun <id> --failed`. Never `gh workflow run ci.yml` on a PR branch.
- **Host load:** at most two cold cargo builds at a time, with `nice -n 10` and `CARGO_BUILD_JOBS=4` (bb `host:build-slots`).
