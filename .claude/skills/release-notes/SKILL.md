---
name: release-notes
description: Write the brust.dev release notes entry for a new brust version (website/pages/docs/ReleaseNotes.tsx). Use before tagging a release, or when asked to write, draft or update release notes or a changelog. Covers gathering the merged PRs, verifying every claim, and the page's format and tests.
---

# Writing release notes for brust

The notes live in one page, `website/pages/docs/ReleaseNotes.tsx` (served at `/docs/release-notes`). Each version is one section, newest first. A version gets its notes **before** its tag: the notes PR is step 1 of the **release** skill.

## 1. Gather what changed

```bash
PREV=v2.0.0-alpha.<N-1>
git fetch origin
git log --oneline --first-parent $PREV..origin/main          # the merged PRs ("Merge pull request #NNN") and direct docs commits
gh pr view <n> --json title,body --jq '.title, .body'         # each PR's own summary, disclosures and numbers
git diff $PREV origin/main -- docs/shadcn-coverage.md         # page tiers and KB that moved
```

- Docs-only commits on main (plans, ledger) are not user-facing, so leave them out.
- Test-only PRs get no entry unless users notice the effect.
- The ledger (`docs/plans/m1a-followups.md`) explains the F-numbers that PR bodies cite.

## 2. Verify every claim before you write it

- **Numbers:** take KB, tiers and island counts from the regenerated `docs/shadcn-coverage.md` or the PR's measured table, never from memory or an estimate. If a number was only estimated, do not print it.
- **Behaviour:** read the code that the claim describes (a function, a list of names, a flag) and quote only what it does. For example, before naming "the five SyntheticEvent members", read the table in `packages/runtime-dom/src/directives/on.ts`.
- **Fixes:** say what went wrong in the user's terms (what they saw), then what happens now. If the fix makes something fall back to React, say that, and say the output is the same.
- **Behaviour changes users must act on** (a rebuild, a removed flag, a changed default, code that now runs at a different time) go first in **Changes**, in plain words and with the action.

## 3. Format

For each new version, make two edits in `ReleaseNotes.tsx`:

1. A toc entry at the top of the `toc` array in `releaseNotesLoader`:
   ```ts
   { id: 'alpha-N', title: '2.0.0-alpha.N' },
   ```
2. A section inserted directly above the previous version's `<h2>`:
   ```tsx
   <h2 id="alpha-N">2.0.0-alpha.N · 15 October 2026</h2>
   {/* source: the pull requests merged after v2.0.0-alpha.<N-1>: #A–#B (ledger rows / lanes) */}
   <p>One sentence: what this version is about, for a user deciding whether to upgrade.</p>

   <h3>New</h3>      {/* features someone can use now */}
   <h3>Fixed</h3>    {/* wrong output, crashes, build errors on valid React */}
   <h3>Security</h3> {/* hardening a reviewer signed off; never print an exploit */}
   <h3>Changes</h3>  {/* behaviour changes, fallbacks, docs-only news */}
   ```

Rules:

- Leave out any heading that has no items.
- Every `<li>` has a source comment just above it naming the PR (and the ledger row or plan) it comes from: `{/* source: PR #250 (F206) */}`. The page header requires this. Reviewers check claims against it.
- Each `<li>` opens with one bold sentence that states the outcome. One or two plain sentences follow. Wrap code, props and file names in `<code>`.
- Write for app authors. Use no internal task names, agent names or F-numbers in the visible text (they belong in the source comments). Prefer "renders with React" to "falls back".
- In JSX, escape `{` as `{'{'}` and `}` as `{'}'}`, and apostrophes as `&rsquo;`. Use real arrows (`→`) and en dashes for ranges (`#247–#251`).
- Use the date of the tag (today), formatted `D Month YYYY`.

## 4. Check, then open the PR

```bash
cd website && bunx biome check pages/docs/ReleaseNotes.tsx
bun test test/release-notes-page.test.ts test/docs-shell.test.ts   # needs the native addon: bun install && (cd ../packages/brust && bun run build:debug)
```

- `release-notes-page.test.ts` checks that every published version has an entry, newest first, and that every cited path exists.
- Open the PR as `website: 2.0.0-alpha.N release notes` from a lane branch off `origin/main`.
- Merge it only after green CI. Then continue with the **release** skill, step 2.
