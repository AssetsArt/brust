# brust docs site (example/docs) — Design Spec

**Date:** 2026-06-11
**Branch:** `feat/docs-md` (off main `b80c315`, brustjs 0.1.40-alpha)
**Quality bar:** impeccable skill (brand register for Home, product register for docs
chrome) — constraints baked into §Visual and enforced at review/polish time.

## Goal

A brand-new documentation site for brust, built FROM SCRATCH (the removed
`example/docs` TSX site and `feat/docs-site` branch are reference-free — content is
rewritten against the real API), dogfooding the just-released markdown pipeline:

- All doc pages are `.md` via `mdRoutes()` + `mdNav()`.
- Home is a native TSX landing with an animated **grainient** WebGL hero.
- `brust build --ssg` produces a static site deployable to Cloudflare Pages (root
  path).

## Non-goals (v1)

- Full-text search (⌘K palette searches titles + headings only).
- Versioned docs, i18n, llms.txt (follow-ups; llms.txt is cheap later from the same
  scan).
- Cloudflare deploy automation (build output + manual instructions only; needs the
  user's CF account).
- Any framework changes. Gaps found while dogfooding go to
  `example/docs/FRAMEWORK-GAPS.md`, not into runtime/ on this branch.

## Architecture

```
example/docs/
  index.ts                  # brust.run entry (worker/main branches per pokedex pattern)
  routes.tsx                # Home route + ...mdRoutes('content', { prefix: '/docs',
                            #   layout: DocsLayout, components: {...} })
  brust.toml                # port (avoid pokedex's)
  PRODUCT.md / DESIGN.md    # impeccable project context (written FIRST, drives the rest)
  content/                  # 15 .md files (frontmatter: title, description, nav{group,order})
  pages/Home.tsx            # native landing (BrustPage shell)
  components/
    DocsLayout.tsx          # native layout: BrustPage + header + sidebar(mdNav) + <main><Outlet/></main> + pager
    GrainientBackground.tsx # export const behavior — WebGL2 shader (port of chain-builder's
                            #   Vue component, itself reactbits.dev "Grainient", MIT)
    ThemeToggle.tsx         # export const behavior (pokedex pattern; data-theme on <html>)
    SearchPalette.tsx       # React island (⌘K) — the ONLY hydrated React on the site
  lib/
    search-index.ts         # build-time generator: scanMdDir → public/search-index.json
  app.css                   # Tailwind v4 + tokens (OKLCH) + GFM-table styling + shiki dual-theme css
  public/                   # favicon, logo.svg, search-index.json (generated)
  FRAMEWORK-GAPS.md         # dogfood log
```

- **No own package.json** — runs from the repo workspace (`bun example/docs/index.ts`),
  same as pokedex; avoids the documented dual-React `file:` trap. Deps it needs
  (tailwindcss v4, shiki, marked) are already root deps.
- Root `package.json` scripts: `docs:dev`, `docs:build` (→
  `brust build example/docs/index.ts --out-dir example/docs/dist --ssg`).

### Content map (15 md files + Home)

| group (frontmatter `nav.group`) | pages |
|---|---|
| Getting Started | introduction, installation, first-route, project-structure, commands |
| Concepts | routing, rendering, native-interactivity, store, actions, styling |
| Guides | markdown-pages *(new — the feature that built this site)*, deployment |
| Reference | cli, agents |

- URLs: `/docs/<slug>`; `/docs` redirects… **no** — `content/index.md` IS the docs
  landing (`/docs`, a short "how these docs are organized" page + links), so every
  URL is a real md page. Home stays `/`.
- Every page's content is REWRITTEN from the real API (runtime source + README +
  architecture.md as source of truth; the old docs are known to have drifted — do
  not copy from `feat/docs-site`).
- Embedded live demos: the markdown-pages guide embeds a real `<Counter …/>` island
  + a behavior component INSIDE the md (the page demonstrates the feature it
  documents). Other pages use fenced code only.

### Interactivity budget

| piece | kind | notes |
|---|---|---|
| GrainientBackground | native behavior (WebGL2) | Home only; RAF loop in `ctx.effect`, cleanup on unmount; `prefers-reduced-motion` → static first frame (no RAF); WebGL unavailable → static CSS gradient fallback; canvas `aria-hidden` |
| ThemeToggle | native behavior | persists in localStorage; pre-hydration inline script in `<head>` sets `data-theme` to avoid FOUC (head via BrustPage `head` prop) |
| SearchPalette | React island (`csr`) | ⌘K / `/` opens; fuzzy over `search-index.json` (title + h2/h3 per page); arrow-key nav; `<dialog>` element (escapes stacking contexts per impeccable) |
| Sidebar, pager, breadcrumbs | server-rendered | from `mdNav()` + loader data; zero JS |

## Visual design (impeccable constraints — binding)

**Register:** Home = brand; docs chrome = product. Named reference: “chain-builder
green over a grainient field” — palette is INHERITED brand identity (chain-builder’s
shipped scale), so reflex-reject palette rules don’t apply to the greens; they DO
apply to everything else.

- **Palette (OKLCH, dark-first):** brand greens from chain-builder — light-bg link
  `#0d684b`-equivalent, dark-bg `#46e7b4`-equivalent, solid CTA `#139069`; grainient
  trio `#1bcf96 / #27aeff / #08050b`. Scene sentence: *developers reading docs at
  night next to an editor → dark default, light theme offered.* Docs body bg = true
  near-black at brand-hue chroma ≤0.015 (dark) / true off-white chroma 0 (light) —
  NOT cream.
- **Typography:** body+display = **Schibsted Grotesk** (Google Fonts; not on the
  reflex-reject list; voice words: *fast, plainspoken, engineered*), code =
  **Spline Sans Mono**. Self-hosted woff2 in `public/fonts` (SSG = no runtime
  Google requests). Single family + weight contrast (impeccable: deliberate
  single-family is stronger than a timid pair). Display letter-spacing ≥ -0.03em.
  Hero clamp max ≤ 5.5rem. `text-wrap: balance` on h1–h3, `pretty` on prose. Body
  measure ≤ 72ch. Implementer may swap fonts ONLY by following the impeccable font
  procedure and documenting the three voice words in DESIGN.md.
- **Bans honored (deviations from chain-builder where they conflict):**
  - NO gradient text — hero name is solid `#1bcf96`-class green on the dark
    grainient; emphasis by weight/size. (chain-builder’s gradient hero name is
    explicitly not copied.)
  - Glass pill navbar over the grainient is the ONE purposeful glass use; docs
    pages use a plain solid header (no blur).
  - Feature section: NOT an identical icon-card grid. Asymmetric composition — one
    lead feature block (native-first rendering with a real numbers line: e.g.
    measured RPS from the repo bench, cited) + a tight two-column list for the
    rest. No uppercase tracked eyebrows; no numbered section scaffolding.
  - No side-stripe borders on callouts — md blockquote/callout styling uses
    background tint + full hairline border.
  - Cards ≤ 12px radius; no 1px-border + ≥16px-blur shadow pairs.
- **Contrast:** body ≥ 4.5:1 both themes (verified in the polish pass with actual
  computed colors); code-block tokens rely on shiki’s github-light/github-dark
  (already AA-reasonable); link green on dark uses the `#46e7b4` end of the scale.
- **Motion:** grainient is the page-load moment (brand permission). Everything else
  is restrained: hover/focus transitions ≤ 200ms ease-out-quart; no scroll-reveal
  scaffolding. `prefers-reduced-motion: reduce` → grainient renders ONE frame and
  stops; theme/menu transitions become instant. Content never gated on animation.
- **Z-index scale:** `--z-nav: 10; --z-palette-backdrop: 40; --z-palette: 50` —
  no arbitrary 999s.
- **A11y:** skip-to-content link; sidebar nav is `<nav aria-label="Docs">`; current
  page `aria-current="page"`; palette is `<dialog>` with focus trap; keyboard
  shortcuts documented in the palette’s empty state; all interactive hit areas
  ≥ 40px.

## Build / SSG / deploy

- `bun run docs:dev` → dev server with md hot reload (the 0.1.40 watcher).
- `bun run docs:build` → `dist/` + `dist/static/` (SSG). Search-index generation
  runs INSIDE the entry at boot/build (a small module imported by index.ts main
  branch writes `public/search-index.json` from `scanMdDir` before serve; the SSG
  child process re-runs the entry so the index exists in both modes) — if this
  proves awkward, fallback: a `predocs:build` bun script. Plan decides; spec
  requires only: the JSON exists and is correct in dev, dist boot, and static
  output.
- Cloudflare Pages (manual): build command `bun install && bun run docs:build`,
  output `example/docs/dist/static`. Documented in `example/docs/README.md`.
  Root-path only (SSG v1 constraint) — custom domain or `*.pages.dev` both fine.
- SSG output budget: every page < 100KB HTML (excluding shiki CSS variables
  inlined styles); island JS loaded ONLY on pages that embed islands (Home loads
  zero React; the markdown-pages guide + any palette-bearing page load the
  bootstrap). NOTE: the palette island is in the DocsLayout → every /docs page
  hydrates it; that is the accepted budget (one small island), Home does NOT
  include the palette (header link to /docs instead).

## Testing & acceptance

Tests live in `tests/docs-site.test.ts` (server-assert pattern, no playwright in
CI; browser verification is the orchestrator's job):

1. Build: `bun run docs:build` exits 0; `dist/static/` contains 16 html pages,
   `_brust/islands/*`, css, `search-index.json`, fonts.
2. Served statically (in-test file server): `/`, `/docs`, every nav page → 200;
   Home HTML contains the grainient canvas host (x-data) and NO React bootstrap;
   a docs page contains sidebar with `aria-current` on itself, pager links, and
   the palette island host; the markdown-pages guide contains a live island host
   with content-addressed id.
3. Dev boot: all pages 200 (one smoke), md edit hot-reload NOT re-tested here
   (covered by framework tests).
4. `bun run ci` (biome) green; no `crates/` or `runtime/` diffs on this branch.
5. **Browser (orchestrator, Playwright MCP):** grainient animates (and freezes
   under emulated reduced-motion), theme toggle persists across reload, ⌘K opens
   palette + keyboard nav + navigates, island demo in markdown-pages guide is
   interactive, no console errors (favicon included), contrast spot-checks via
   computed styles on body text both themes.
6. **Impeccable polish pass (orchestrator):** run the skill's ban checklist
   against rendered pages (gradient-text, eyebrows, card grids, border+shadow
   pairs, radius, letter-spacing, line length) — failures are fix-then-ship.

Acceptance = all six green + FRAMEWORK-GAPS.md exists (even if empty) +
PRODUCT.md/DESIGN.md committed.

## Content accuracy invariant

Every API statement in content/*.md must be verifiable against `runtime/` source
or a test in the repo. The content-writing tasks require the implementer to cite
(in the task report, not the page) the source file for each API claim. Known
drift areas from the last audit: action/treaty signatures, store API names,
native template constraints — re-verify, don't trust memory.

## Known limitations

- Static deploy = full-page navs (no SPA payload endpoint) — acceptable; pages are
  small.
- Search is title/heading-only.
- The palette island hydrates on every docs page (~ one chunk + react vendor) —
  accepted v1 budget.
- Home hero copy is bilingual-ready but v1 ships English only.

## Open questions → plan time

1. Exact grainient uniform tuning (port values from chain-builder's component
   verbatim first; tune only if the look diverges).
2. Search index shape (`[{title, path, headings:[{text, anchor}]}]` proposed).
3. Whether `/docs` index.md needs `nav.order` special-casing to sit first in the
   sidebar's first group (mdNav sorts by order — give it order 0).
