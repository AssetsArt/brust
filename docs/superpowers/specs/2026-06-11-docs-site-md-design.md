# brust docs site (example/docs) — Design Spec

**Date:** 2026-06-11
**Branch:** `feat/docs-md` (off main `b80c315`, brustjs 0.1.40-alpha)
**Status:** Reviewed (adversarial subagent pass applied)
**Quality bar:** impeccable skill (brand register for Home, product register for docs
chrome) — constraints baked into §Visual and enforced at review/polish time.
**Plans:** TWO — Plan 1: site shell + pipeline (routes, layout, Home, islands,
build/SSG, tests); Plan 2: the 16 content pages (own accuracy-verification loop).

## Goal

A brand-new documentation site for brust, built FROM SCRATCH (content rewritten
against the real API; do NOT copy from the removed site or `feat/docs-site`),
dogfooding the just-released markdown pipeline:

- All doc pages are `.md` via `mdRoutes()` + `mdNav()`.
- Home is a native TSX landing with an animated **grainient** WebGL hero.
- `brust build --ssg` produces a static site deployable to Cloudflare Pages (root
  path).

## Non-goals (v1)

- Full-text search (⌘K palette searches titles + headings only).
- Versioned docs, i18n, llms.txt (follow-ups).
- Cloudflare deploy automation (build output + manual instructions only).
- Any framework changes. Gaps found while dogfooding go to
  `example/docs/FRAMEWORK-GAPS.md`.

## Architecture

```
example/docs/
  index.ts                  # brust.run entry (worker/main branches per pokedex pattern)
  routes.tsx                # Home route + mdRoutes('content', {prefix:'/docs', layout, components})
  brust.toml                # [server] port = 1340 (non-default; effective because all
                            #   commands run with cwd = example/docs — see §cwd contract)
  PRODUCT.md / DESIGN.md    # impeccable project context (written FIRST)
  content/                  # 16 .md files (index.md + 15 pages)
  pages/Home.tsx            # native landing (BrustPage shell)
  components/
    DocsLayout.tsx          # native layout: BrustPage + header + sidebar + <main><Outlet/></main> + pager
    GrainientBackground.tsx # export const behavior — WebGL2 (port of chain-builder's component,
                            #   itself reactbits.dev "Grainient", MIT). Used INLINE:
                            #   <GrainientBackground native /> inside Home's body (auto x-data
                            #   injection is inline-only). Default export = static <canvas> host.
    ThemeToggle.tsx         # export const behavior — localStorage + data-theme on <html>
    SearchPalette.tsx       # React island (⌘K) — the ONLY hydrated React on the site
  lib/
    search-index.ts         # index generator module (see §Search index)
    nav.ts                  # layout-loader helper: nav tree + per-item active flags + pager
  app.css                   # Tailwind v4 + tokens (OKLCH) + GFM-table + callout styling
  public/                   # favicon, logo.svg, fonts/*.woff2, search-index.json (generated)
  FRAMEWORK-GAPS.md         # dogfood log
```

- **No own package.json** (dual-React trap). Deps (tailwindcss v4, shiki, marked)
  are already root deps.

### The cwd contract (BINDING — review blocker B1)

`mdRoutes` content dirs, island chunk-id hashing, `.brust/` mirrors, and
`brust.toml` discovery are ALL cwd-relative by design. Every command runs with
**cwd = example/docs**; there is no `brust` bin in-repo, so root scripts are:

```json
"docs:dev":   "cd example/docs && bun ../../runtime/cli/index.ts dev index.ts",
"docs:build": "cd example/docs && bun ../../runtime/cli/index.ts build index.ts --out-dir dist --ssg"
```

`routes.tsx` passes the content dir as the **relative string `'content'`** (the
manifest-stable pattern from tests/fixtures/app/routes.tsx). Tests spawn build/boot
subprocesses with `cwd: example/docs` (the tests/md-routes.test.ts pattern).

### Content map (16 md files + Home = 17 HTML pages)

| nav | pages |
|---|---|
| *(ungrouped → `group: null` bucket, sorts first — standalone "Overview" link)* | index.md (`/docs`, order 0) |
| Getting Started | introduction, installation, first-route, project-structure, commands |
| Concepts | routing, rendering, native-interactivity, store, actions, styling |
| Guides | markdown-pages *(embeds a LIVE `<Counter/>` island + a behavior demo — the page demonstrates the feature that built it)*, deployment |
| Reference | cli, agents |

- Content rewritten from the real API (runtime source + README + architecture.md).
- **Three-identity rule (explicit):** every md-embedded component (Counter demo,
  behavior demo) must be a **default import in routes.tsx** whose ident == the
  `components` registry key == the md tag name. `DocsLayout` must likewise be a
  named default import (chain composition resolves via `scanImports(routes.tsx)`).
  md-embedded behavior demos must be fully static with literal props.

### Docs chrome data flow (review blocker B3 — pinned mechanism)

Native templates can't call functions or compare values, so the sidebar/pager are
**precomputed in a loader attached to the layout parent route**:

```ts
const [docsTree] = mdRoutes('content', { prefix: '/docs', layout: DocsLayout, components })
docsTree.loader = async ({ path }) => buildDocsChrome(path)   // lib/nav.ts
```

`buildDocsChrome(path)` returns `{ nav: [{group, items: [{title, path, active}]}],
pager: {prev?: {title, path}, next?: {title, path}} }` — per-item `active` booleans
and resolved prev/next objects (no comparisons in jinja). Chain loaders merge
top-down so the leaf's `__md` head fields still win. This attachment pattern is
undocumented framework surface → log in FRAMEWORK-GAPS.md ("mdRoutes layout has no
first-class loader option").

### Interactivity budget

| piece | kind | notes |
|---|---|---|
| GrainientBackground | native behavior (WebGL2) | Home only, inline `<GrainientBackground native/>`; RAF in `ctx.effect` with returned cleanup; `prefers-reduced-motion` → render ONE frame, no RAF; WebGL unavailable → static CSS gradient fallback on the canvas's parent; canvas `aria-hidden` |
| ThemeToggle | native behavior | localStorage `theme` + `data-theme` on `<html>`. FOUC killer: BrustPage `head` accepts `{ tag: 'script', text: '…' }` with RAW static-literal text (lower.rs HeadTag::Script — fully supported), so an inline pre-paint script reads localStorage and stamps `data-theme`. The script goes in **BOTH** document shells (Home's BrustPage AND DocsLayout's BrustPage). NOTE: pokedex's cookie approach does NOT work on a static host — this localStorage+head-script design is the static-compatible one. `text` is static-literal only. |
| SearchPalette | React island | `<Island component={SearchPalette} hydrate="idle" />` in DocsLayout (NO `ssr` prop → empty host until hydrate; `csr` is an md-tag attr, NOT an Island prop). ⌘K / `/` opens; `<dialog>` (escapes stacking contexts); arrow-key nav; fuzzy over search-index.json |
| Sidebar, pager | server-rendered | from the layout loader; zero JS |

### Search index (review blocker B2 — pinned mechanism)

Generated at **routes-module import time** in `lib/search-index.ts`, imported by
`routes.tsx`, gated `if (!isWorker)` (exported from brustjs): writes
`public/search-index.json` synchronously before anything else uses it. This lands
the file in dev (entry import), in `dist/public` (build.ts imports routes.tsx
BEFORE the public copy), and in SSG static output (copied from entryDir/public
after crawl) — all three modes for free, no lifecycle scripts (`bun run` has no
pre/post hooks).

- Shape: `[{ title, path, headings: [{ text, anchor }] }]`.
- Anchors MUST replicate `runtime/md/render.ts`'s slugger exactly (lowercase, trim,
  `\s+`→`-`, strip non-word, per-page dedupe `-2,-3…`) — pinned; a unit test
  compares against rendered output for one page.
- `scanMdDir` is not public API → relative-import `runtime/md/scan.ts` (in-repo
  example precedent) + FRAMEWORK-GAPS entry ("no public md scan/utils export").
- Known caveat (accepted): index regenerates per boot/build, NOT on md hot-edit —
  restart picks it up; logged, not fixed, in v1.

## Visual design (impeccable constraints — binding)

**Register:** Home = brand; docs chrome = product. Named reference: “chain-builder
green over a grainient field”. The greens are INHERITED brand identity
(chain-builder’s shipped scale) — reflex-reject palette rules don’t apply to them;
they DO apply to everything else.

- **Palette (OKLCH, dark-first):** brand greens — light-bg link `#0d684b`-class,
  dark-bg `#46e7b4`-class, solid CTA `#139069`; grainient trio
  `#1bcf96 / #27aeff / #08050b`. Scene: *developers reading docs at night next to
  an editor → dark default, light offered.* Dark body bg = near-black, brand-hue
  chroma ≤ 0.015; light = true off-white chroma 0 — NOT cream.
- **Typography:** single family **Schibsted Grotesk** (display+body, weight
  contrast carries hierarchy) + **Spline Sans Mono** (code). Self-hosted woff2 in
  `public/fonts` — procurement step in the plan (download from Google Fonts /
  @fontsource, extract woff2); if files can't be procured the build falls back to
  a system stack (`system-ui` + `ui-monospace`) and the gap is logged — the build
  NEVER blocks on font binaries. Display letter-spacing ≥ -0.03em; hero clamp max
  ≤ 5.5rem; `text-wrap: balance` on h1–h3, `pretty` on prose; measure ≤ 72ch.
  Font swaps only via the impeccable procedure + voice words in DESIGN.md.
- **Bans honored (deliberate deviations from chain-builder):**
  - NO gradient text — hero name solid brand green on the dark grainient.
  - Glass pill navbar over the grainient = the ONE purposeful glass use; docs pages
    use a plain solid header.
  - Features: asymmetric composition — one lead block (native-first rendering with
    a real measured number cited from the repo bench) + tight two-column list. No
    identical icon-card grids, no uppercase tracked eyebrows, no numbered section
    scaffolding.
  - Callouts: background tint + full hairline border (no side-stripes).
  - Radius ≤ 12px on cards; no 1px-border + ≥16px-blur shadow pairs.
- **Contrast:** body ≥ 4.5:1 both themes (verified with computed colors at polish);
  dark-theme links use the `#46e7b4` end.
- **Motion:** grainient = the page-load moment. Everything else ≤ 200ms
  ease-out-quart; no scroll-reveal scaffolding. Reduced motion → grainient one
  frame; transitions instant. Content never gated on animation.
- **Z-index scale:** `--z-nav: 10; --z-palette-backdrop: 40; --z-palette: 50`.
- **A11y:** skip link; `<nav aria-label="Docs">`; `aria-current="page"` (precomputed
  active flag); palette `<dialog>` + focus trap; hit areas ≥ 40px.

## Build / SSG / deploy

- `bun run docs:dev` / `bun run docs:build` per §cwd contract.
- Cloudflare Pages (manual, documented in example/docs/README.md): build
  `bun install && bun run docs:build`, output `example/docs/dist/static`.
  Root-path only.
- Budget: island JS only where embedded. Home: **no `_bootstrap.js`** (it has no
  islands; `_directives.js` IS present — behaviors exist app-wide and the directive
  runtime force-bakes on every native page; the test asserts the precise thing).
  Docs pages hydrate exactly one island (palette).

## Testing & acceptance

`tests/docs-site.test.ts` (server-assert pattern; subprocesses spawn with
`cwd: example/docs`; suite-unique ports e.g. 3831/3832):

1. Build: `docs:build` equivalent exits 0; `dist/static/` has 17 html pages,
   `_brust/islands/*`, css, `search-index.json`, fonts (or system-stack fallback
   noted).
2. Static serve (in-test file server): `/` + `/docs` + every nav page → 200; Home
   has the grainient x-data host and NO `_bootstrap.js`; a docs page has sidebar
   with exactly one `aria-current="page"` (itself), pager links, palette island
   host; markdown-pages guide has a live island host (content-addressed id hashed
   vs example/docs cwd).
3. Dev/server boot smoke: all pages 200.
4. Search index: exists in dist/public + static out; anchors of one page match the
   rendered heading ids byte-for-byte.
5. `bun run ci` green; `git diff --stat runtime/ crates/` empty on the branch.
6. **Browser (orchestrator):** grainient animates + freezes under reduced-motion,
   theme persists across reload (no FOUC), ⌘K opens/navigates, md-embedded island
   demo interactive, no console errors, contrast spot-checks both themes.
7. **Impeccable polish pass (orchestrator):** ban checklist vs rendered pages —
   fix-then-ship.

Acceptance = 1–7 green + FRAMEWORK-GAPS.md + PRODUCT.md/DESIGN.md committed.

## Content accuracy invariant

Every API statement in content/*.md must be verifiable against `runtime/` source or
a repo test. Content tasks report (in the task report) the source file for each API
claim. Known prior drift: action/treaty signatures, store API names, native
template constraints — re-verify everything.

## Known limitations

- Static deploy = full-page navs.
- Search = title/heading only; index regenerates per boot, not per md edit.
- Palette island hydrates on every docs page (accepted budget).
- English only.

## Resolved questions

1. Grainient uniforms: port chain-builder's values verbatim; tune only if the look
   diverges (compare side-by-side in the browser pass).
2. Search shape pinned above.
3. index.md sits in the ungrouped `group: null` bucket with order 0 → standalone
   "Overview" entry above the groups (mdNav: null-group bucket sorts by first
   appearance of the globally sorted sequence; order 0 guarantees first).
