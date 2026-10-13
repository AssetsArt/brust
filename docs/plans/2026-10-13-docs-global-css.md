# L29 docs-global-css: the docs site's stylesheet goes through the brust CSS pipeline (F130)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @8e4cc6c7 · flow: lane → PR → CI → lead merges → lead redeploys (`cd website && bun run deploy`) · ledger row: F130

## Why

Human request, 2026-10-13: "แก้ docs site ให้ไปใช้ global css ได้ไหมจะได้ Minifying CSS auto" — the site's stylesheet should be built by brust (bundled, minified, content-hashed, `immutable`) instead of being served as written.

Today `website/public/app.css` (47 KB, hand-written, unminified) is linked by hand in two places: `components/Layout.tsx:57` (every page under the layout) and `pages/NotFoundPage.tsx:12` (the 404 and the `/docs/routes` redirect route, which render outside the layout). Files under `public/` are served as they are, without a hash, `max-age=3600` (see `dist/static/_headers`).

## Rulings

- **R30.1 One global entry.** Move `website/public/app.css` to `website/app.css` (git mv, content unchanged) and list it in `website/brust.toml` as `[css] global = ["app.css"]` (`docs/css.md` §1). Global, not a layout import, because the 404 page is outside `DocsLayout`/`Layout` and must get the same stylesheet; `[css] global` links on every route.
- **R30.2 No hand-written link.** Remove both `<link rel="stylesheet" href="/public/app.css" />` tags. The server inserts `<link … href="/_brust/client/app-<hash>.css" data-brust-css>` right after `<meta charset>` (`docs/css.md` §3); the Google Fonts links stay as they are.
- **R30.3 Nothing else moves.** `public/favicon.svg`, the generated `public/sitemap.xml` / `public/llms.txt`, `scripts/pages-extras.ts` and the deploy script are unchanged. If the CSS build rewrites or rejects anything in `app.css` (a `url()`, an `@import`, nesting, a selector the minifier changes), report it with the exact build output and fix the CSS, not the pipeline; a pipeline bug goes to the lead as a challenge.
- **R30.4 Proof.** `brust build --target static` output: `dist/static/_brust/client/app-<hash>.css` exists and is minified (no newline-indented rules; size before/after in the task note), `public/app.css` no longer exists in the output, every page's HTML (including `404.html`) links the hashed file exactly once and no page links `/public/app.css`; `_headers` gives it `immutable` through the existing `/_brust/client/*` rule. Visual parity: screenshots of `/`, `/docs/quickstart` and the 404, light and dark, 400 px and 1280 px, before and after; any difference is a finding.
- **R30.5 Tests follow.** `website/test/static.test.ts` (file list: no `public/app.css`; a check that each built page links one `/_brust/client/*.css` and no `/public/app.css`), and any website test that reads `public/app.css` from disk. Docs pages that DESCRIBE `public/app.css` as an example of a user's file (`DevMode.tsx`, `DevLoopDemo.tsx`, `Cli.tsx`) are about brust behaviour, not this site; leave them. `ProjectStructure.tsx` belongs to L28 part B (Dew); do not touch it.

## Lane

| slug | tier | boundary | gates |
|---|---|---|---|
| `docs-global-css` | standard | `website/app.css` (moved from `website/public/app.css`), `website/brust.toml`, `website/components/Layout.tsx`, `website/pages/NotFoundPage.tsx`, `website/test/**` (as R30.5), `docs/plans/m1a-followups.md` (F130) | `cd website && bun run typecheck`, each `website/test/*.test.ts` alone, `bun run build:static` + R30.4 checks, screenshots as task notes; CI |
