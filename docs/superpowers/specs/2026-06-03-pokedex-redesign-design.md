# PokéDex example — full redesign (public webpage + Tailwind v4 + framework showcase)

> Status: design · 2026-06-03 · CLEAN-SLATE rewrite of `example/pokedex/`. Old tree backed up to
> `example/pokedex.bak.2026-06-03` (gitignored). Implementation **deletes** the old files and authors
> fresh — NOT an in-place edit/diff of the old code.

## Goal

Re-author the brust PokéDex example so it reads as a **real consumer web product** (landing → browse →
detail), not an admin/back-office dashboard, styled entirely with **Tailwind v4**, and intentionally
**showcases each brust capability** at a natural point in the app. Add a client-side keyed-`x-for`
feature (the 0.1.28-alpha capability the old example never exercised) and dogfood it end-to-end.

## Non-goals (loud)

- **No framework/runtime/compiler changes.** This is `example/pokedex/` only (+ its `app.css`). If a
  native-authoring limitation blocks a design choice, work around it in the loader/CSS — do NOT change
  the compiler or runtime. (If something genuinely can't be expressed, the spec flags it as a deferred
  showcase, not a framework edit.)
- **No new npm release.** Example-only; nothing to publish. (A separate release decision at the end.)
- **No unit tests for the example app.** Example apps are verified by `brust build` (native compile) +
  the framework's own integration suite + browser smoke — not bespoke unit tests. (See Verification.)
- **No SSR/streaming, no per-request React** — every page stays `native: true` (compiled to minijinja,
  rendered in Rust). Interactivity is islands (React) + native directive components (react-free x-*).
- Not aiming for a pixel-perfect brand system; aiming for a clean, modern, credible product look.

## High-level architecture (unchanged framework contracts, new content)

Every route `native: true`; one router-level `AppLayout` owns the `<BrustPage>` shell + single `<main>`
+ `<Outlet/>`; leaf pages are fragments. Each leaf loader returns its view-model **plus** the chrome
fields AppLayout reads from the merged flat context (`title`, `crumb`, `teamProps`, `mode`, and any
nav-state the layout needs). Interactivity:

- **React islands** (`<Island>`): `TeamBuilder` (team dock, reads `defineStore`), `AddToTeamButton`
  (detail page), `NavPreloader` (top progress bar, `useNav`).
- **Native directive components** (single-file `export const behavior` + JSX `default`, react-free):
  `ThemeToggle`, `NavLink`, and **new `DexFilter`** (the keyed-`x-for` showcase).
- **defineStore** `pokedex.team` shared across the two team islands.
- **navigation** `brustjs/navigation`: NavLink active state, NavPreloader phase bar, and at least one
  **imperative `navigate()`** call (e.g. the hero search submits → `navigate('/pokedex', {query:{q}})`).
- **cookies + request-context**: dark/light mode via the `mode` cookie, read in every loader, set by
  the `/theme` action; `<BrustPage data-mode={mode}>` on `<html>`.

### Information architecture (routes)

| route | page | native | loader | notes |
|---|---|---|---|---|
| `/` | **Home** | ✓ | `homeLoader` | hero + search CTA + featured strip + browse-by-type tiles + team preview island |
| `/pokedex` | **Browse** | ✓ | `browseLoader` | server grid (gen-1, 151) + **DexFilter** client instant filter/sort (keyed `x-for`) |
| `/pokemon/{name}` | **Detail** | ✓ | `detailLoader` | hero, stat bars, types, abilities, evolution, AddToTeam island; `notFound()` → 404 |
| `/type-chart` | **Type chart** | ✓ | `typeChartLoader` | 19×19 effectiveness matrix (nested `.map()`) |

`/` changes meaning (was the list; now a landing). The browse list moves to `/pokedex`. The hero
search and "browse all" CTAs route to `/pokedex`.

## Tailwind v4 setup

`example/pokedex/app.css`:
```css
@import "tailwindcss";
@source "./**/*.{tsx,ts}";          /* scan JSX class strings + loader-built literal classes */
@custom-variant dark (&:where([data-mode="dark"], [data-mode="dark"] *));
@theme {
  /* brand accents as CSS vars so inline type-colors + utilities share one palette */
  --color-brand-500: oklch(0.55 0.2 264);
  /* ...a small brand scale; rely on Tailwind defaults otherwise */
}
```
- **Dark mode** keys off `[data-mode="dark"]` on `<html>` (the existing cookie/request-context flow) so
  `dark:` utilities work AND the cookies showcase survives. No `prefers-color-scheme` (cookie wins).
- **Dynamic, data-derived colors** (the 18 Pokémon type colors, per-stat bar colors, detail hero tint)
  are applied via **inline `style`** from a loader-provided value (native supports `style={{…}}`
  objects + member-path values) — NOT via dynamically-constructed Tailwind class names (Tailwind's
  scanner can't see runtime-built class strings). Static layout/spacing/typography = Tailwind utilities.
- Component-scoped CSS modules are NOT used (keep it one `app.css` + utilities + inline style).

## Native authoring rules (the contract every page/loader follows)

From `native-route-authoring-constraints`:
- Native templates interpolate **member paths** (`{x.y}`), **`.map()`** (incl. nested), **inline
  conditionals** (`{c ? a : b}`, `{c && x}`), **`style={{…}}`** objects (literal + member-path values),
  and **dynamic `<BrustPage>` head/`data-*`**. NO helper calls / template literals / arithmetic in
  templates → the **loader precomputes** every formatted string, className, href, inline-style value,
  and any island/x-data `x-props` JSON (`JSON.stringify` in the loader, emitted XSS-safe).
- `<Island props={…}>` value must be a **single member path** (or omit props).
- AppLayout owns the single `<main>`; leaves are fragments. Leaf loaders supply chrome fields.
- Static Tailwind utility strings in `className` pass straight through the compiler (they're literals).

## DexFilter — the keyed-`x-for` showcase (detailed)

A **native directive component** `components/DexFilter.tsx` (single-file: `export const behavior` +
JSX `default`). Demonstrates client-side instant filter + sort over a server-provided dataset, with
keyed reconcile so matching cards keep DOM identity (no image reload/flash) and focus survives.

**Data in:** `browseLoader` fetches gen-1 (151) via one `fetchList(0,151)` (no per-item fetch; artwork
derived from id) and precomputes `dexProps = JSON.stringify({ items: [{id,name,displayName,num,artwork,
detailHref}] })`. Browse page renders `<DexFilter native x-props-from-loader />` — i.e. the JSX template
carries `x-props="{{ (dexProps) | e }}"` via a member-path prop, same mechanism as `addProps` today.

**Behavior** (`brustjs/store` signals, react-free):
```
behavior = ({ el, props }) => {
  const all = props.items as Card[]
  const q = signal('')
  const sort = signal<'dex'|'az'>('dex')
  const filtered = computed(() => {
    const needle = q().trim().toLowerCase()
    let out = needle ? all.filter(c => c.name.includes(needle)) : all.slice()
    if (sort() === 'az') out = out.slice().sort((a,b) => a.name < b.name ? -1 : 1)
    return out
  })
  const onInput = (e: Event) => q.set((e.target as HTMLInputElement).value)
  const setDex = () => sort.set('dex')
  const setAz  = () => sort.set('az')
  const countLabel = computed(() => `${filtered().length} / ${all.length}`)
  return { q, sort, filtered, onInput, setDex, setAz, countLabel }
}
```

**Template** (the keyed `x-for` lives here):
```jsx
<section x-data="dexFilter" className="…">
  <input x-on-input="onInput" placeholder="Filter by name…" className="…" />
  <div className="…">{/* sort buttons */}<button x-on-click="setAz">A–Z</button>…</div>
  <p x-text="countLabel" className="…" />
  <div className="grid …">
    <a x-for="c in filtered by c.id" x-bind-href="c.detailHref" className="… card …">
      <span x-text="c.num" className="…" />
      <img x-bind-src="c.artwork" x-bind-alt="c.displayName" loading="lazy" className="…" />
      <div x-text="c.displayName" className="…" />
    </a>
  </div>
</section>
```
- `x-for="c in filtered by c.id"` → keyed reconcile (0.1.28-alpha). Filtering removes/re-adds only
  changed keys; matching cards keep their `<img>` (no reload). Sorting reorders by moving nodes
  (identity preserved). `read(scope,"c.displayName")` exercises the unwrap-each-hop path.
- The `<input>` lives OUTSIDE the `x-for` list → never torn down; typing keeps focus naturally. The
  showcase claim is **card DOM identity preserved across filter/sort** (the visible no-flash result).
- `x-bind-src`/`x-bind-href`/`x-bind-alt` go through `setBound` (else-branch `setAttribute`) — fine.

Risk: 151 small objects as one `x-props` JSON ≈ a few KB inline — acceptable. If it bloats, cap the
dataset (e.g. 60) and note it (no silent truncation — `countLabel` shows the real total).

## "Built with brust" showcase section

A styled footer/section (marketing "features" look, NOT a debug panel) on the Home page listing the
capabilities and where each is used, e.g.:
- Native SSR routes (Rust-rendered) · Loaders + ISR · Cookies + request-context (theme) · `defineStore`
  (team) · Client navigation (`useNav`, NavLink, imperative `navigate`) · React islands · **Keyed
  `x-for`** (browse filter) · Nested `<Outlet/>` layout · Treaty actions.

Each item = short label + one-line "where". Keeps the page looking like a product landing while making
the framework story legible.

## File structure (clean slate — delete then author)

**Delete** the entire old working tree `example/pokedex/*` (backup retained). **Author fresh:**

```
example/pokedex/
  index.ts                 # boot entry (server setup) — re-author minimal
  routes.tsx               # 4 routes under AppLayout
  app.css                  # Tailwind v4 entry (above)
  actions.ts               # /theme + team add/remove treaty actions
  public/favicon.svg       # keep (copy from backup)
  lib/
    pokeapi.ts             # fetch helpers (port from backup; trim to what's used)
    loaders.ts             # homeLoader, browseLoader, detailLoader, typeChartLoader
    types.ts               # view-model types
    team-store.ts          # server-side team store (or stores/team.ts client defineStore)
  stores/team.ts           # defineStore('pokedex.team')
  components/
    AppLayout.tsx          # public shell: navbar + main + Outlet + footer + islands
    NavLink.tsx            # native directive (active via nav store)
    ThemeToggle.tsx        # native directive (cookie theme)
    NavPreloader.tsx       # React island (useNav progress bar)
    DexFilter.tsx          # NEW native directive (keyed x-for)
    TeamBuilder.tsx        # React island (team dock, defineStore)
    AddToTeamButton.tsx    # React island (detail)
  pages/
    HomePage.tsx           # hero + featured + type tiles + team preview + showcase
    BrowsePage.tsx         # DexFilter mount + intro
    DetailPage.tsx         # detail
    TypeChart.tsx          # matrix
  README.md                # short: what this example shows
```
pokeapi.ts / types.ts / the islands' core logic may be **ported** from the backup (re-authored, not
diffed), but all markup/styling is rewritten with Tailwind. Old `aa-*`/`dex-*`/`ks-*` classes are gone.

## Verification (no example unit tests — build + integration + browser smoke)

1. `bun run build` (biome) clean on the new TS.
2. `cd /Users/detoro/code/brust && bun run --cwd . runtime/cli/index.ts build example/pokedex/index.ts`
   (or the repo's `brust build` invocation) **succeeds** — every native page compiles to jinja, css
   pipeline emits `dist/css/app.css`, island + directive chunks emit. No compiler rejects.
3. Framework integration suite still green (we changed no framework code): the native-island / cli-build
   tests that don't depend on the OLD pokedex markup. **Check first** whether any test asserts old
   pokedex DOM (`cli-build.test.ts` /native-islands is a known pre-existing degrade per memory) — if a
   test hard-codes old pokedex content, that's a test-fixture coupling to fix or note, not a regression
   we introduced.
4. **Boot + browser smoke** (chrome-devtools MCP), the real gate for a visual app:
   - `BRUST_PORT=39600 bun run runtime/cli/index.ts dev example/pokedex/index.ts` (build first).
   - Home renders (hero, featured, tiles, team preview, showcase). Navbar nav works (SPA).
   - Theme toggle flips `<html data-mode>` + persists (reload keeps it) via cookie.
   - Browse: DexFilter renders 151 cards; typing in the filter narrows instantly; **capture that a
     surviving card's `<img>` element identity is unchanged across a filter keystroke** (keyed x-for
     no-reload) and that A–Z reorders without rebuilding nodes; `countLabel` updates.
   - Detail: renders stats/types/evolution; AddToTeam updates the team dock (defineStore sync).
   - NavPreloader bar shows on navigation.
5. `bun run typecheck:treaty` still 0 (we don't touch the treaty graph).

## Acceptance criteria

1. Old `example/pokedex` markup/design-system fully replaced; no `aa-*`/`dex-*`/`ks-*` classes remain;
   `app.css` is Tailwind v4 (`@import "tailwindcss"`).
2. `brust build example/pokedex` succeeds; all 4 native pages compile; css + chunks emit.
3. App looks like a public product (navbar + hero + sections + footer), not an admin dashboard.
4. Every listed capability is used at a real point AND named in the "Built with brust" section.
5. DexFilter keyed `x-for` filters + sorts; browser smoke confirms card DOM identity preserved across a
   filter keystroke (the deferred 0.1.28 focus/identity dogfood) — captured, not just asserted in prose.
6. Theme toggle persists via cookie; dark mode via `[data-mode="dark"]` Tailwind variant.
7. No framework/runtime/compiler files changed (diff scope = `example/pokedex/**` + the spec/plan docs).
8. biome clean; typecheck:treaty 0; framework integration suite no NEW failures.

## Known limitations (documented)

- DexFilter dataset is bounded (gen-1 151) and shipped as inline `x-props` JSON — not a paginated/
  virtualized list. Intentional: it's a keyed-`x-for` showcase, not a production data grid.
- No `<Suspense>`/streaming (native routes render in Rust) — slow fetches (evolution) block in the
  loader, as before.
- Native loaders still can't stream; detail's evolution chain loads blocking.
- `cli-build.test.ts /native-islands` may stay on its known pre-existing degrade (dual-React SSR);
  not in scope to fix here (memory `cli-build-native-islands-preexisting-fail`).

## Open questions — resolved at design time

- **clean slate vs edit** ✅ delete + author fresh (user directive "ลบเขียนใหม่"); backup retained.
- **`/` becomes landing** ✅ list moves to `/pokedex`; home is a real landing.
- **Tailwind dark mode** ✅ `@custom-variant dark` on `[data-mode="dark"]` (keeps cookie showcase).
- **keyed x-for placement** ✅ DexFilter client filter/sort on Browse (dogfoods 0.1.28-alpha).
- **dynamic colors** ✅ inline `style` from loader values (not runtime-built Tailwind classes).

## Slices (for the plan)

1. **Design system + shell:** `app.css` (Tailwind), `AppLayout` (navbar/footer/Outlet/islands shell),
   `ThemeToggle`, `NavLink`, `NavPreloader` restyled; `routes.tsx`; delete old tree; build green.
2. **Home:** `HomePage` + `homeLoader` (hero, featured strip, type tiles, team preview, showcase).
3. **Browse + DexFilter:** `BrowsePage` + `browseLoader` (151 dataset, dexProps JSON) + `DexFilter`
   native directive (keyed x-for) ; build + smoke the filter.
4. **Detail:** `DetailPage` + `detailLoader` + `AddToTeamButton` restyle; `notFound` 404.
5. **Type chart + team dock:** `TypeChart` + `typeChartLoader`; `TeamBuilder` island restyle (use keyed
   x-for for the team list too, if cheap).
6. **Polish + verify:** README, full browser smoke pass, scope/diff check.
