# L28 blank-template-tailwind: the blank starter uses Tailwind CSS v4 (F129)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @0093ec5 · flow: lane → PR → CI → lead merges (part A); docs lane from `docs-site` → lead merges (part B) · ledger row: F129 · supersedes R25.1 of `2026-10-13-gaps-round.md` §L25

## Why

Human request, 2026-10-13: "แก้หน้า docs/project-structure ทำ blank template ใหม่ใช้ Project structure ที่ใช้ Tailwind CSS v4 คือให้ blank template ใช้ Tailwind CSS v4" — the blank template itself uses Tailwind CSS v4, and the Project structure docs page shows that layout.

Today: L25 (#168, #179) made the starter page with a hand-written `public/app.css` (docs palette as CSS custom properties) and ruled "no dependency" (R25.1). L21 (#167) added `bun create @brust/app --tailwind`, which rewrites the blank scaffold after copying (`packages/create-app/src/tailwind.ts` `applyTailwind`: root `app.css` with `@import "tailwindcss"` + `@theme`, the layout imports it, `public/app.css` removed, pinned dev deps `tailwindcss 4.3.3` + `bun-plugin-tailwind 0.1.2`). The human now wants the Tailwind shape to be THE blank template.

## Rulings

- **R29.1 One blank template, Tailwind by default.** The template directory `packages/create-app/templates/blank/` ships the Tailwind shape; `applyTailwind` and its post-copy rewrite go away. `--tailwind` stays accepted and prints one line ("Tailwind CSS v4 is the default; the flag does nothing") so older instructions do not fail; no `--no-tailwind` (YAGNI; a user who wants plain CSS deletes `app.css`'s import).
- **R29.2 Dependencies.** `bun install` is already required by the starter (`@brust/core`), so the two pinned dev dependencies are allowed; still no CDN, no web font, nothing fetched at runtime (the rest of R25.1 stands).
- **R29.3 Same look, Tailwind tokens.** The starter page keeps its L25 design (mark, name, one sentence, native counter in a panel, three links, light/dark, focus ring at ≥ 3:1) with Tailwind utilities; the docs palette lives in `app.css` as `@theme` tokens (`--color-paper`, `--color-sheet`, `--color-ink`, `--color-ink-2`, `--color-rule`, `--color-amber`, `--color-amber-ink`, light values; dark via `@media (prefers-color-scheme: dark)` overriding the same tokens, or `dark:` variants) so classes read `bg-paper text-ink border-rule`. No `tailwind.config`; v4 CSS-first only.
- **R29.4 Tiers unchanged.** `HomePage` static, `Counter` native, no react chunk (R25.4); the built CSS is one hashed, minified file linked by brust after `<head>` (L19), and `public/favicon.svg` is still the docs favicon byte for byte (R25.2 test stays).
- **R29.5 Tests follow the shape.** `packages/create-app/test/templates.test.ts` (file list: `app.css` at the root, no `public/app.css`, dev deps pinned to `TAILWIND_DEV_DEPS`), `scaffold.test.ts` (builds the scaffolded app: tiers; the served HTML links `/_brust/client/*.css` and contains a Tailwind utility class that is used by the page; `count is` still present), and the existing `--tailwind` scaffold test becomes the no-op-flag test. `docs/create-app.md` section 3 rewritten (blank = Tailwind; the flag note).

## Part A — v2 lane `blank-template-tailwind` (Dew)

Boundary: `packages/create-app/templates/blank/**`, `packages/create-app/src/{tailwind.ts,args.ts,cli.ts,templates.ts}`, `packages/create-app/test/**`, `docs/create-app.md`, `docs/plans/m1a-followups.md` (row F129). Gates: `cd packages/create-app && bun run typecheck && bun test` (scaffold test included), CI. Screenshots light/dark/400 px of the scaffolded page as task notes (R25.3).

## Part B — docs-site lane `docs-project-structure` (Dew, after A merges into v2 and the lead merges v2 into `docs-site`)

Branch from `docs-site` (see `2026-10-13-docs-site-sync.md`, "Rules for every docs lane"). Boundary: `website/pages/docs/ProjectStructure.tsx` (the tree: `app.css` at the root with its role, no `public/app.css`, `devDependencies` in the scripts block, what `brust build` writes for CSS under `dist/`), `website/pages/docs/Installation.tsx` (one sentence: blank uses Tailwind CSS v4), `website/pages/docs/Css.tsx` (one sentence pointing at the starter), `website/test/reference.test.ts` or the page's test. `Quickstart` needs no change: it reads the template files at build time. Gates: `cd website && bun run typecheck && bun test`; screenshots light/dark/400 px.

## Task table

| slug | tier | role | deps | acceptance |
|---|---|---|---|---|
| `blank-template-tailwind` | standard | implementer (Dew) | none | Part A boundary, R29.1–R29.5, CI green, F129 row |
| `docs-project-structure` | standard | implementer (Dew) | `blank-template-tailwind` merged + lead's v2→docs-site merge | Part B; site tests green; screenshots |

**Amendment 2026-10-13 (docs site merged into v2, PR #182):** Part B branches from `v2` (`conclave lane start`), not from `docs-site` (deleted); flow is lane → PR → CI (the server job runs `website` typecheck and each `website/test/*.test.ts`) → lead merges → lead redeploys with `cd website && bun run deploy`.
