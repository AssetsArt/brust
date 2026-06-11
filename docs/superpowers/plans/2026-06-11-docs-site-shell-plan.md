# Plan 1: docs site shell + pipeline (example/docs)

Spec: `docs/superpowers/specs/2026-06-11-docs-site-md-design.md` — read §cwd contract,
§Docs chrome data flow, §Search index, §Visual (BINDING) before any task.

**Rules:** TDD where a unit is testable; server-assert integration per
tests/md-routes.test.ts pattern. Lint `bun run ci; echo $?` (raw exit). NO changes
under runtime/ or crates/ — gaps go to example/docs/FRAMEWORK-GAPS.md. NEVER
`git add -A`. All example/docs commands run with cwd=example/docs. Commits:
`feat(docs-site): …` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Spec coverage

| Spec item | Task |
|---|---|
| PRODUCT/DESIGN/GAPS docs, scaffold, brust.toml, scripts, tokens | 1.1 |
| search-index (import-time, slugger parity) | 1.2 |
| nav.ts + layout loader + DocsLayout chrome | 1.3 |
| ThemeToggle + FOUC head script (both shells) | 1.4 |
| GrainientBackground + Home | 1.5 |
| SearchPalette island | 1.6 |
| tests/docs-site.test.ts + SSG e2e | 1.7 |
| README (CF deploy) + fonts procurement | 1.8 |

## Task 1.1 — scaffold + design context

Files: `example/docs/{PRODUCT.md,DESIGN.md,FRAMEWORK-GAPS.md,index.ts,routes.tsx,brust.toml,app.css}`,
`example/docs/content/index.md` (stub: frontmatter `title: Overview`, `nav: { order: 0 }`,
two paragraphs), root `package.json` scripts (`docs:dev`, `docs:build` per spec §cwd).

- PRODUCT.md: product=brust docs site; audience=developers evaluating/using brust;
  register=brand(Home)/product(docs); voice words: *fast, plainspoken, engineered*.
- DESIGN.md: the spec §Visual translated to tokens — OKLCH palette (dark default +
  light), type scale (1.25 ratio, hero clamp ≤5.5rem), spacing, z-index scale,
  radius ≤12px, motion rules (≤200ms ease-out-quart, reduced-motion policy).
- app.css: Tailwind v4 `@theme` tokens implementing DESIGN.md (follow
  example/pokedex/app.css for the Tailwind-v4-in-brust pattern); GFM table +
  callout (tint + hairline) styles; shiki `.shiki` dual-theme vars
  (light theme via `[data-theme="light"]` selector flipping `--shiki-*`).
- index.ts: copy pokedex worker/main pattern (example/pokedex/index.ts), strip MCP.
- routes.tsx: Home route (`pages/Home.tsx` minimal BrustPage placeholder — real hero
  in 1.5) + `mdRoutes('content', { prefix: '/docs', components: {} })` (layout added
  in 1.3 — for now leaves render standalone). brust.toml `[server] port = 1340`.
- Verify: `bun run docs:dev` boots from repo root script; `curl :1340/` and
  `/docs` → 200. Commit.

## Task 1.2 — search index

Files: `example/docs/lib/search-index.ts`, `example/docs/lib/search-index.test.ts`,
wire import into routes.tsx (top, before mdRoutes).

- Per spec: import-time, `if (!isWorker)` (import from brustjs root export — check
  `runtime/index.ts:77` export), relative-import `scanMdDir` from
  `../../../runtime/md/scan.ts`; replicate render.ts slugger EXACTLY (read
  runtime/md/render.ts:400-432; copy the algorithm, cite it in a comment); extract
  h2/h3 from md body via line regex outside fences; write
  `public/search-index.json` (pretty=false).
- Tests: slug parity (render one md body via marked? NO — keep it unit: feed the
  same heading set through both your slugger and a fixture of expected ids copied
  from a REAL rendered page — the integration parity check lives in 1.7), dedupe
  suffixes, fence-shielded headings ignored, index shape.
- FRAMEWORK-GAPS entry: "no public md scan/slug export — relative import".

## Task 1.3 — nav + DocsLayout

Files: `example/docs/lib/nav.ts` (+test), `example/docs/components/DocsLayout.tsx`,
routes.tsx (layout + loader attach).

- nav.ts `buildDocsChrome(path)`: calls `mdNav('content')` (public export), maps to
  `{nav: [{group, items: [{title, path, active}]}], pager: {prev, next}}` —
  active = strict path equality; pager order = the flattened sorted sequence.
  Unit tests with a tmp content dir (pattern from runtime/md/routes.test.ts).
- routes.tsx: `const [docsTree] = mdRoutes('content', {prefix:'/docs',
  layout: DocsLayout, components: {...}}); docsTree.loader = async ({path}) =>
  buildDocsChrome(path)`.
- DocsLayout.tsx (NATIVE — member-path + .map() only, precomputed everything):
  BrustPage (title/description via `__md.*` member paths — see
  tests/fixtures/app/pages/MdDocsLayout.tsx), skip link, solid header (logo →
  `/`, Overview/GitHub links, ThemeToggle host placeholder until 1.4, palette
  host placeholder until 1.6), `<nav aria-label="Docs">` sidebar:
  `nav.map(group => …items.map(item => <a aria-current={…}>)` — NOTE native
  constraint: conditional attr from a boolean — check what the compiler supports
  for conditional attributes in .map (memory: keyed x-for + inline conditionals
  work; if conditional ATTR is unsupported, precompute `ariaCurrent: 'page'|''`
  string in nav.ts and bind directly — choose whichever compiles, document it).
  `<main><Outlet/></main>`, pager footer (prev/next links, hide-when-absent via
  inline conditional).
- Verify: dev boot → `/docs/introduction`-stub… (add 2 more stub md files in
  content/ so sidebar/pager have real structure; the real content lands in
  Plan 2). Server-assert: exactly one `aria-current="page"`. Commit.

**BLOCKED fallback:** if conditional-attr-in-.map fights the compiler, precompute
attribute STRINGS in nav.ts (`current: 'page' | ''`) — `aria-current=""` is
invalid-but-harmless; prefer a precomputed class instead and use `aria-current`
only via the supported form. Report what compiled.

## Task 1.4 — ThemeToggle + FOUC script

Files: `example/docs/components/ThemeToggle.tsx`, head script in BOTH BrustPage
shells (Home placeholder + DocsLayout).

- Behavior: button toggling `document.documentElement.dataset.theme` between
  'dark'/'light' + localStorage('brust-docs-theme'); icon swap via x-show or two
  spans + class toggle (KEEP fully static-compilable; follow
  example/pokedex/components/ThemeToggle.tsx for the behavior-ctx pattern but
  REPLACE the cookie mechanism with localStorage).
- Head script (RAW static-literal text, one-liner):
  `(()=>{try{const t=localStorage.getItem('brust-docs-theme');if(t)document.documentElement.dataset.theme=t}catch{}})()`
  via BrustPage `head={[{ tag: 'script', text: '…' }]}` in both shells. Default
  (no stored value) = dark (the `:root` default in app.css).
- Verify: dev → toggle flips data-theme + persists (will browser-verify in P6;
  here assert the script text appears in both rendered heads + x-data host).

## Task 1.5 — Grainient + Home

Files: `example/docs/components/GrainientBackground.tsx`, `example/docs/pages/Home.tsx`.

- Port /Users/detoro/code/chain-builder/docs/site/.vitepress/theme/components/GrainientBackground.vue
  (239 lines, raw WebGL2, zero deps) into `export const behavior = (ctx) => {…}`
  with `ctx.effect(() => { …RAF…; return cleanup })`; default export
  `<canvas class="grainient" aria-hidden="true"></canvas>`. Uniform values
  VERBATIM. reduced-motion: matchMedia check → render one frame, skip RAF.
  WebGL2 null → set a class on the canvas parent enabling a static CSS gradient.
  Resize via ResizeObserver (cleanup!).
- Home.tsx (impeccable brand register — spec §Visual is BINDING; re-read it):
  full-viewport hero over `<GrainientBackground native/>`; glass pill navbar
  (the ONE glass use): logo, Docs, GitHub; hero: solid-green name (NO gradient
  text), tagline, two CTAs (Get Started → /docs/introduction, GitHub); below the
  fold: asymmetric feature composition — lead block (native-first rendering +
  one real number cited from repo bench/README — find an actual figure, cite the
  file in the task report) + two-column tight list (islands, md pages+SSG,
  actions/treaty, store, MCP) — varied rhythm, no identical cards, no eyebrows;
  footer (MIT, GitHub). Copy: plainspoken, no marketing froth.
- Verify: dev → `/` 200, canvas x-data host present, no `_bootstrap.js` in Home
  HTML (`_directives.js` IS expected). Commit.

## Task 1.6 — SearchPalette island

Files: `example/docs/components/SearchPalette.tsx`, DocsLayout host
(`<Island component={SearchPalette} hydrate="idle" />`), routes.tsx default import.

- React island: `<dialog>`; opens on ⌘K / Ctrl+K / `/`; fetches
  `/search-index.json` once on first open; fuzzy = simple includes-ranking over
  title+headings (no dep); arrow keys + Enter → `location.href` (full-page nav is
  fine on static); Esc closes; focus trap via dialog; empty state lists the
  shortcuts. Styling per DESIGN.md tokens (z-index scale; radius ≤12px).
- Server-assert: island host present on docs pages with content-addressed id.

## Task 1.7 — integration + SSG e2e

Files: `tests/docs-site.test.ts`.

Per spec §Testing items 1–5 (build via the docs:build command shape with
cwd=example/docs; static serve with in-test file server; 17-page count happens in
Plan 2 — HERE assert "every md file in content/ has a page", count-agnostic;
search-index anchor parity vs ONE rendered page byte-for-byte; no
runtime//crates/ diffs assertion is a git check in P6, skip in-test). Ports
3831/3832. Kill children in finally. Run file twice for port races.

## Task 1.8 — README + fonts

Files: `example/docs/README.md`, `example/docs/public/fonts/*` (+@font-face in app.css).

- Fonts: try `bunx @fontsource/schibsted-grotesk`-style procurement — practical
  path: `bun add -d @fontsource/schibsted-grotesk @fontsource/spline-sans-mono`
  then COPY the woff2 files (latin, 400/500/700 + mono 400/600) into
  public/fonts and `bun remove` the packages (no runtime dep). If unavailable
  offline → system stack fallback + FRAMEWORK-GAPS note; build must stay green.
- README: run/dev/build, Cloudflare Pages manual steps (build command, output
  dir `example/docs/dist/static`, root-path note), content-authoring guide
  (frontmatter shape, embedding components, three-identity rule).
