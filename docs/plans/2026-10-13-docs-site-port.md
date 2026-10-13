# docs-site-port: build the brust docs site in `website/` from the approved mockup — landing page + interactive docs, Pokémon examples

**RULED by lead Detoro 2026-10-13 (plan written by the lead). Human: "เริ่ม port มาเป็น brust document เลย ยังไม่เอาภาษาไทย ฝั่ง docs เน้น interactive ใช้ Pokemon เป็น example".**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: docs-site @760cadb · canon: website/design/mockup.html @760cadb

## Goal

`website/` serves, with `brust build` + `brust start` on the workspace `@brust/core`:
- `/` — the landing page, a faithful port of the mockup (neo-mirai skin, dusk poster with the playable `$ brust build` button, tmux session, benchmark panel, three-tier tabs with live demos, the remaining sections, closing band).
- `/docs/{slug}` — the docs, step-based and code-first, every guide page with at least one **live Pokémon demo built as a brust component**.

The site is its own proof: each demo is a real brust component, and `website/test/` asserts the tier the page claims (a page that says "native" fails the test if the compiler picked react).

## Global constraints (every task inherits these)

1. **Branch and flow.** Work branches from `docs-site` via `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 <slug>` FROM `/Users/detoro/code/brust` (worktree lands under `.claude/worktrees/`). The lead merges lanes into `docs-site` directly — no PRs (human rule, bb `rule:docs-site-branch`). Never touch `v2` or `main`.
2. **Design canon** is `website/design/mockup.html` @760cadb. Port its tokens, type scale, spacing, components and motion; do not redesign. A visual change the canon does not cover → `task challenge` to the lead with a screenshot.
3. **impeccable rules apply** (the site's `PRODUCT.md` is at the branch root): no colored side-stripe borders, no bounce/elastic easing, no animating width/height/padding (transform/opacity only), body text ≥ 4.5:1, every animation has a `prefers-reduced-motion` alternative, reveals enhance an already-visible default. Run `node /Users/detoro/.claude/skills/impeccable/scripts/detect.mjs --json <files>` on changed CSS/TSX; READY needs 0 findings.
4. **No Thai text** for now. Fonts: Chakra Petch (display), Zen Old Mincho (text), Azeret Mono (code/labels), Google Fonts link in the layout `<head>`. Drop Noto Serif Thai.
5. **Pokémon assets** load from PokeAPI URLs (see `website/design/README.md`), never committed. Pokémon data lives in ONE module, `website/lib/pokemon.ts` (id, name, types, art/shiny/sprite URL helpers; a curated Gen-1 set of ~24 including 1, 4, 7, 25, 133, 143, 150).
6. **Numbers are real.** Benchmark figures come from `bench/RESULTS.json` read by a loader at request/build time — never hard-coded, never compared with another framework. CLI output shown on the site is real output.
7. **Dogfood, no hand-written client JS.** Interactivity is brust components only (native tier first, react islands only where the canon needs real React). No `<script>` tags in TSX unless the spike (Task A1.1) proves a widget impossible otherwise and the lead rules it in.
8. **Dependencies.** `@brust/core: workspace:*`, React 19. No new runtime dependency without a lead ruling (the react-tier demo uses an in-repo custom hook, not a library). **Ruled in:** `shiki` as a `website/` dependency only (challenge dd484eca on site-foundation, Dew).
9. **Gates for every READY** (paste counts, not logs): `cd website && bun run typecheck && bun test` 0 fail; `bun run build` exit 0 with empty stderr; `brust start` then every route the lane touched returns 200 (unknown route 404); screenshots of every touched page in light + dark at 1440px and 400px via Playwright from `tests/server/` (it has `playwright`; launch with `--use-angle=swiftshader` if WebGL ever matters) saved under the lane scratchpad and listed in READY; detector 0 findings.

## Interaction → tier table (VERIFIED by Task A1.1, 2026-10-13: `brust build` manifest tiers + Chromium runtime check, 0 page errors)

| Widget (canon) | Observed tier | How (what the spike proved) |
|---|---|---|
| Code block Copy button | native | `useState` label + `onClick` → `navigator.clipboard.writeText(text).then(ok, fail)`; `setTimeout` reset inside the handler stays native; clipboard holds the text |
| Tabs (tiers section) | native | `useState` selected tab; panels toggled by `hidden`, `aria-selected` on the tabs |
| tmux session intro | static | markup only; motion is CSS keyframes (no JS) |
| Poster `$ brust build` | native | two `useState` + two `setTimeout` inside `onClick`; lit → done → unlit observed |
| Benchmark count-up + histogram grow | native | `useRef` + `useEffect` + `IntersectionObserver` + `setInterval`; the final value is in the SSR HTML first |
| Step rail fill | native | `useEffect` scroll listener → `document.documentElement.style.setProperty('--rail', …)` |
| Docs "On this page" scrollspy | native | `useEffect` + scroll listener + `useState` active id → `aria-current` |
| `CatchCard` demo | native | two `useState`, ternary `src` (normal/shiny), controlled checkbox, toggle button |
| `PokemonSearch` demo | react | in-repo `useDebounced` → `warning hook-unsupported`, ssr job + react island; debounce observed (filter lands after the delay) |
| `PokemonCard` demo | static | props only |
| `CodeBlock` (syntax colors) | static | Spike: `dangerouslySetInnerHTML` is a build error today (`no-innerhtml`). RULING (lead, 2026-10-13): lane inner-html (v2) adds it; CodeBlock = server-highlighted HTML in `<code dangerouslySetInnerHTML>`; until v2 merges into docs-site, CodeBlock shows plain escaped text behind the same props. Spike caveat: a child that highlights its own literal `code` prop gets a precompute job and fails the build (`instance-prop-path`), so highlighted HTML has to arrive as a props path from a loader (challenge filed). |


## Task table (Coordinator dispatches; deps must be `merged` first)

| slug | tier | role | deps | review | acceptance |
|---|---|---|---|---|---|
| `site-foundation` | complex | Implementer (Dew) | — | complex (Mellow) | A1 below; READY lists the verified tier table |
| `site-landing` | standard | Implementer (knock2) | site-foundation | standard (Afrojack) | A2 below |
| `site-docs-shell` | standard | Implementer (Tiësto) | site-foundation | standard (Afrojack) | B below |
| `site-docs-guide` | standard | Implementer (Tiësto or knock2, whoever is free) | site-docs-shell | standard (Afrojack) | C1 below |
| `site-docs-reference` | standard | Implementer (Guetta) | site-docs-shell | standard (Afrojack) | C2 below |

`site-landing` and `site-docs-shell` run in parallel (disjoint files). `site-docs-guide` and `site-docs-reference` run in parallel.

## A1 — site-foundation (boundary: `website/public/`, `website/components/{Layout,SiteHeader,SiteFooter,CodeBlock,CopyButton,Button}.tsx`, `website/lib/{pokemon,highlight}.ts`, `website/brust.toml`, `website/package.json`, `website/routes.tsx`, `website/test/`, `bun.lock`, this plan's tier table)

1. **Spike (first, ≤ half a day):** in a scratch route, build the smallest version of each widget in the tier table; `brust build` and read `dist/manifest.json` tiers. Answer explicitly: does `navigator.clipboard` inside an `onClick` keep native? does `setTimeout` inside a handler keep native? does `useEffect` + `IntersectionObserver` keep native? does a ternary `src` + controlled checkbox keep native? can a static component render pre-highlighted HTML (`dangerouslySetInnerHTML` or equivalent) — if not, how does `CodeBlock` get syntax colors? Amend the tier table above with observed tiers + one line each; delete the scratch route.
2. **Tokens and CSS:** port the canon's `:root` + dark blocks and the skin into `website/public/app.css` (light/dark via `prefers-color-scheme`; no toggle in v1). Body grid + halo, type scale, buttons, code blocks, tier tags.
3. **Layout:** `<html lang="en">`, head (fonts, css, favicon, title per page via props), `SiteHeader` (BRUST wordmark + version from `@brust/core` package.json via loader, nav: Docs, Cookbook, GitHub — no search box until search exists), `SiteFooter` (canon footer).
4. **CodeBlock:** props `{ code, lang, file?, cwd?, html? }`; tab-style bar with file name or `cwd` + `CopyButton`. **Ruled (challenge dd484eca):** highlighting runs in the page **loader**: `lib/highlight.ts` exports `codeBlock({code, lang, file?, cwd?}) => {code, lang, file, cwd, html}` (shiki/core, JS regex engine, grammars ts/tsx/sh/toml/json, module-scope memo, theme mapped to the canon classes k/s/f/t/c/n/ps). `html` renders through `<code dangerouslySetInnerHTML>` once lane `inner-html` (v2) is merged into `docs-site`; until then CodeBlock shows escaped plain text. Reason: a CodeBlock that highlights its own literal `code` prop gets a precompute job and the build fails with `instance-prop-path` (gap G2, bb `gaps:docs-site`), so **every page with code builds its blocks in a loader**. This applies to lanes B, C1, C2.
5. **`lib/pokemon.ts`** per constraint 5.
6. **Test:** `website/test/build.test.ts` asserts routes and, for each component the tier table names, the manifest tier.

## A2 — site-landing (boundary: `website/pages/HomePage.tsx`, `website/components/landing/**`, `website/lib/bench.ts`, `website/test/landing.test.ts`)

Port every landing section in canon order: hero (headline + dusk poster SVG with the native `$ brust build` button; buttons Get started → `/docs/quickstart`, Star on GitHub → repo), tmux session (static CSS intro), facts row, benchmark panel (loader reads `bench/RESULTS.json` via `lib/bench.ts`: brust S/I/D rps, p50, p99, throughput, histogram buckets; count-up + bars native), steps rail, three-tier tabs with the three LIVE demo components (`PokemonCard` static, `CatchCard` native, `PokemonSearch` react) rendered inside the browser frames, data/route section with pins, actions + store, deploy, packages, not-list, closing band with seal, footer. Test: route `/` 200; tiers of the three demos; benchmark numbers equal `bench/RESULTS.json`.

## B — site-docs-shell (boundary: `website/components/docs/**`, `website/lib/nav.ts`, `website/pages/docs/Quickstart.tsx`, `website/routes.tsx` docs block, `website/test/docs-shell.test.ts`)

`lib/nav.ts` = the canon sidebar (Guide 14 pages, Cloudflare 3, Cache adapters 4, Cookbook 5) as `{ group, items: { slug, title, Component } }`; `routes.tsx` generates `/docs/{slug}` routes from it under a `DocsLayout` (sidebar with current page, breadcrumbs, prev/next pager, "Edit this page" link to the TSX file on GitHub, "On this page" scrollspy native). `/docs` → the Introduction page. Port the canon's Quickstart page completely as the reference page; every other nav entry gets a stub page (title + one line "Coming in the content lanes") so the nav and pager work. Step headings use the canon numbered circles.

## C1 — site-docs-guide (boundary: `website/pages/docs/{Introduction,Installation,ProjectStructure,Routing,Loaders,RenderingTiers,Caching,Actions,Store,Configuration,Cli,Deployment,Migrating}.tsx`, `website/components/demos/**`, `website/actions.ts` if a demo needs it, `website/test/guide.test.ts`)

Write the Guide pages from the ruled specs (`docs/design/*.md` on v2) and `docs/*.md`, code-first: one sentence, then a code block; numbered steps only for real sequences. **Every page has at least one live Pokémon demo** that is itself a brust component, for example: Routing — type a path, see which of `/`, `/pokedex`, `/pokemon/{name}`, `*` matches and the decoded params; Loaders — a page whose loader reads `lib/pokemon.ts` by the route param; Rendering tiers — the three demos with their manifest tiers shown; Caching — a button that fetches a cached Pokémon route twice and shows `x-brust-cache` MISS then HIT; Actions — "add to team" calling a real action in `website/actions.ts` (in-memory team, max 6); Store — a team count shared between a native badge and a react island. Test: every Guide route 200 and each demo's tier.

## C2 — site-docs-reference (boundary: `website/pages/docs/{cloudflare,cache-adapters,cookbook}/**`, `website/test/reference.test.ts`)

Port `docs/cloudflare.md`, `docs/cache-adapters.md` (v2) and write the five Cookbook recipes (Hello world, A React island, Form action, Static 404 page, Invalidate the cache) as TSX pages with `CodeBlock`; Pokémon-flavoured examples; content stays faithful to the md sources (they are the reviewed truth). Test: every route 200.

## Risk ledger

- The tier table is a hypothesis until A1.1; a native claim that compiles to react changes the docs text, not the compiler.
- Syntax highlighting inside a static component may need raw HTML; A1.1 decides; do not hand-roll a tokenizer before the ruling.
- PokeAPI hot-linking can be slow or blocked; images need width/height and alt; the layout must not shift when an image fails.
- `bench/RESULTS.json` changes when the bench is re-run; the landing reads it, so numbers move with the file.
- `bun install` after each lane merge (workspace lockfile).
