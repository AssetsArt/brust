# PokéDex redesign — implementation plan (sliced)

Spec: `docs/superpowers/specs/2026-06-03-pokedex-redesign-design.md`. Clean-slate: **delete**
`example/pokedex/*` (backup at `example/pokedex.bak.2026-06-03`, gitignored) then author fresh.
Scope = `example/pokedex/**` ONLY. No framework/runtime/compiler edits.

## Conventions for every slice
- **Native authoring rules (hard):** loaders precompute ALL formatted strings / classNames / hrefs /
  inline-style values / island & directive `x-props` JSON. Templates use member-paths, `.map()` (incl.
  nested), inline conditionals, `style={{…}}` (member-path/literal values), dynamic `<BrustPage>`
  head/`data-*` ONLY. No template-literals/arithmetic/helper-calls in JSX page bodies.
- **Single-return discipline:** AppLayout + every native page = single `return (...)`, NO local `const`
  above it (else SSR soft-fallback, lost `<html>` shell). Destructure props in the signature.
- **Tailwind:** static utility strings in `className` only. Dynamic/data-derived colors → inline
  `style={{...}}` from a loader value. Dark mode via `[data-mode="dark"]` (the `@custom-variant`).
- **Islands** (`<Island>`): React, `props` = single member path. **Native directives**
  (`<X native data={...} />`): single-file `export const behavior` (react-free, `brustjs/store`) + JSX
  default carrying `x-*` attrs; `data` → `x-props={data}` (JSON string from loader).
- **Visual quality:** author real Tailwind markup with frontend-design judgment (spacing, hierarchy,
  responsive grid, hover/focus states, rounded/shadow, a coherent accent palette). Looks like a public
  product, not an admin panel. Match Thai/English copy to the old app's tone where copy is needed.
- **Per-slice gate:** `bun run ci` (biome) + `bun run --cwd . runtime/cli/index.ts build example/pokedex/index.ts`
  must succeed (native compile + css emit) before the slice is "done". (Exact build cmd: confirm via
  `package.json` scripts; the repo boots pokedex with `bun run runtime/cli/index.ts {build,dev} example/pokedex/index.ts`.)

## Spec-coverage table
| Spec area | Slice |
|---|---|
| app.css Tailwind + dark variant + delete old tree + AppLayout shell + Theme/Nav/Preloader + routes | 1 |
| Home (hero/featured/type-tiles/team-preview/showcase) + homeLoader | 2 |
| Browse + browseLoader (151) + DexFilter keyed x-for | 3 |
| Detail + detailLoader + AddToTeamButton + notFound 404 | 4 |
| Type chart + typeChartLoader + TeamBuilder island | 5 |
| README + full browser smoke + scope/diff verify | 6 |

---

## Slice 1 — design system + shell + delete old tree

### 1.1 Delete + scaffold
```bash
# backup already exists at example/pokedex.bak.2026-06-03 (gitignored) — verify, then delete working tree
test -d example/pokedex.bak.2026-06-03 && rm -rf example/pokedex && mkdir -p example/pokedex/{lib,stores,components,pages,public}
cp example/pokedex.bak.2026-06-03/public/favicon.svg example/pokedex/public/favicon.svg
```

### 1.2 `app.css` (Tailwind v4 — GATE on @custom-variant)
```css
@import "tailwindcss";
@source "./**/*.{tsx,ts}";
/* dark mode keyed to the cookie-driven [data-mode="dark"] on <html> (NOT prefers-color-scheme) */
@custom-variant dark (&:where([data-mode="dark"], [data-mode="dark"] *));
@theme {
  --color-brand-50:  oklch(0.97 0.02 264);
  --color-brand-500: oklch(0.55 0.20 264);
  --color-brand-600: oklch(0.49 0.20 264);
}
```
**Build immediately after writing app.css** (even with a stub page) to prove `@custom-variant` compiles.
**BLOCKED fallback:** if `@tailwindcss/node` rejects `@custom-variant`, try `@variant dark (...)`; if that
fails, drop the at-rule and write a `@layer` with explicit `[data-mode="dark"]` selectors for the few
dark overrides used. Record which worked in the slice commit.

### 1.3 `lib/pokeapi.ts` (port from backup, two changes)
Port `example/pokedex.bak.2026-06-03/lib/pokeapi.ts` VERBATIM except:
- `TYPE_COLOR`: replace the `var(--…)` design-token values with **real hex colors** per type (canonical
  Pokémon-type-ish palette, e.g. `fire:'#ef7444'`, `water:'#4d90d5'`, `grass:'#63bb5b'`, … all 18). These
  feed inline `style` (type badges, detail hero tint, stat bars). Keep `STAT_LABEL`, `statBucket`,
  `artwork`, `cap`, `pad`, `idFromUrl`, `ALL_TYPES`, all `fetch*` fns, `RawPokemon`/etc unchanged.

### 1.4 `lib/types.ts`
Define view-model interfaces the loaders return. At minimum: `ChromeData` (`title`, `crumb`, `mode:'dark'|'light'`, `teamProps:{teamInitial:TeamMember[]}`), `TeamMember`, `HomeData`, `BrowseData`, `DetailData`, `TypeChartData` (+ `TypeChartCellVM`), `DexCard` (`{id,name,displayName,num,artwork,detailHref}`), `TypeBadgeVM`. Each page `*Data extends ChromeData`.

### 1.5 `lib/team-store.ts` + `stores/team.ts` (port from backup, unchanged logic)
- `lib/team-store.ts`: server-side store with `.list()`/`.add()`/`.remove()` (port).
- `stores/team.ts`: `defineStore('pokedex.team', () => ({ members: signal<TeamMember[]>([]) }))` (port).

### 1.6 `actions.ts` (port + keep treaty actions)
`/theme` (sets `mode` cookie), team add/remove. Port from backup, keep the `Actions` type export.

### 1.7 `components/AppLayout.tsx` — PUBLIC shell (single-return)
Structure (author Tailwind markup):
- `<BrustPage lang="en" data-mode={mode} title={title} head={[{tag:'link',rel:'icon',href:'/favicon.svg'}]}>`
- **Sticky top navbar**: logo/wordmark (links `/`), nav links (`<NavLink native href="/" label="Home"/>`,
  `<NavLink native href="/pokedex" label="Pokédex"/>`, `<NavLink native href="/type-chart" label="Type chart"/>`),
  right side: `<ThemeToggle native/>` + a "Team" affordance. Use `<nav>`/`<header>` with backdrop blur, border-b.
- `<main>` (THE single main) → `<div class="…content container…"><Outlet/></div>`
- **Footer** (site footer; the "Built with brust" capability list can live here OR on Home — put the
  detailed showcase on Home per slice 2; footer gets a compact version + links).
- Islands at the end: `<Island component={TeamBuilder} props={teamProps} ssr hydrate="load" />`,
  `<Island component={NavPreloader} hydrate="load" />`.
- Props: `{ title, crumb, teamProps, mode }` (crumb optional now — navbar may not show breadcrumbs;
  keep it in ChromeData for pages that want it). Destructure in signature, single return.

### 1.8 `components/NavLink.tsx`, `ThemeToggle.tsx`, `NavPreloader.tsx` (port behavior, restyle markup)
- NavLink: port the `behavior` (nav.path watch → active class) VERBATIM; rewrite the JSX `className`s to
  Tailwind (active state e.g. `text-brand-600 font-semibold`, base `text-slate-600 …`). Keep `x-data`,
  `x-bind-class`, `x-bind-aria-current`.
- ThemeToggle: port `behavior` VERBATIM (flips `document.documentElement.dataset.mode` + `/theme` action);
  restyle button with Tailwind. Keep `x-data`/`x-text`/`x-on-click`.
- NavPreloader: port the `useNav` progress-bar island; restyle with Tailwind (fixed top, brand bar).

### 1.9 `routes.tsx` (4 children, all native)
```tsx
export const routes = defineRoutes([
  { Component: AppLayout, native: true, children: [
    { path: '/',                Component: HomePage,  native: true, loader: homeLoader },
    { path: '/pokedex',         Component: BrowsePage, native: true, loader: browseLoader },
    { path: '/pokemon/{name}',  Component: DetailPage, native: true, loader: detailLoader },
    { path: '/type-chart',      Component: TypeChart,  native: true, loader: typeChartLoader },
  ]},
])
```

### 1.10 `index.ts` (boot entry — port from backup)
Minimal server boot (port the backup's `index.ts`; adjust nothing framework-level).

### 1.11 Stubs to compile
Create minimal stub `HomePage`/`BrowsePage`/`DetailPage`/`TypeChart` + their loaders returning chrome
fields + empty data, so slice 1 BUILDS green. Real content lands in slices 2-5.

**Gate:** biome clean; `brust build example/pokedex` succeeds; `@custom-variant` accepted (or fallback
recorded); boot dev once → navbar + theme toggle + SPA nav work (quick smoke).

**BLOCKED fallback (whole slice):** if native build rejects any AppLayout construct, reduce to the
backup's known-good AppLayout shape (it compiled) and re-skin incrementally.

---

## Slice 2 — Home (`HomePage` + `homeLoader`)
`homeLoader({req})` returns `HomeData extends ChromeData`:
- `featured`: ~6-8 `DexCard` (a curated id list, e.g. starters/legendaries → `fetchList` or fixed ids +
  `artwork(id)`; precompute displayName/num/href).
- `typeTiles`: `ALL_TYPES.map(t => ({ name:t, label:cap(t), color:TYPE_COLOR[t], href:`/pokedex?q=${t}`? }))`
  (href optional; tiles can be decorative or link to a filtered browse — keep simple: link to `/pokedex`).
- `teamProps`, `title:'PokéDex · brust'`, `crumb:'Home'`, `mode`.

`HomePage` sections (Tailwind, native rules — `.map()` for featured/tiles, inline `style` for tile color):
1. **Hero**: gradient bg, big headline, subcopy, a search `<form>`/input + CTA buttons ("Browse all"→
   `/pokedex`, "Type chart"→`/type-chart`). The hero search is a small **native directive** OR a plain
   `<a>`/form — if interactive imperative `navigate()` is wanted, make a tiny `HeroSearch.tsx` native
   directive whose behavior does `navigate('/pokedex',{query:{q:value}})` on submit (showcases imperative
   nav). (If a directive is overkill, a `<form action="/pokedex" method="get">` also works — but the
   spec wants an imperative `navigate()` showcase, so prefer the directive.)
2. **Featured strip**: horizontal scroll/grid of featured cards (`.map()`).
3. **Browse by type**: tile grid, each tile `style={{background:t.color}}` (inline), `.map()`.
4. **Your team preview**: an `<Island>` (reuse TeamBuilder or a small read-only preview island reading
   the `pokedex.team` store) — OR a static "open team" CTA. Keep it an island to showcase defineStore.
5. **Built with brust** showcase: styled features grid (label + one-line "where"), per spec.

**Gate:** build green; home renders in browser; hero search navigates (if directive).

---

## Slice 3 — Browse + DexFilter (keyed x-for — the dogfood)
`browseLoader({req})` returns `BrowseData extends ChromeData`:
- `const {results} = await fetchList(0, 151)`; `items = results.map(r => ({id:r.id, name:r.name,
  displayName:cap(r.name), num:pad(r.id), artwork:artwork(r.id), detailHref:`/pokemon/${r.name}`}))`.
- `dexProps = JSON.stringify({ items })`.
- chrome fields; `title:'Pokédex · Browse'`, `crumb:'Pokédex'`.

`BrowsePage`: intro/header + `<DexFilter native data={dexProps} />`.

`components/DexFilter.tsx` — **complete behavior** (this is load-bearing; author verbatim, then style the JSX):
```tsx
import { computed, signal } from 'brustjs/store'

interface Card { id: number; name: string; displayName: string; num: string; artwork: string; detailHref: string }

export const behavior = ({ props }: { el: HTMLElement; props: unknown }) => {
  const all = ((props as { items?: Card[] })?.items ?? []) as Card[]
  const q = signal('')
  const sortAz = signal(false)
  const filtered = computed(() => {
    const needle = q().trim().toLowerCase()
    let out = needle ? all.filter((c) => c.name.includes(needle)) : all.slice()
    if (sortAz()) out = out.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return out
  })
  const onInput = (e: Event) => q.set((e.target as HTMLInputElement).value)
  const setDex = () => sortAz.set(false)
  const setAz = () => sortAz.set(true)
  const countLabel = computed(() => `${filtered().length} / ${all.length}`)
  return { q, sortAz, filtered, onInput, setDex, setAz, countLabel }
}

export default function DexFilter({ data }: { data?: string }) {
  return (
    <section x-data="dexFilter" x-props={data} className="/* tailwind */">
      <div className="/* controls row */">
        <input x-on-input="onInput" type="search" placeholder="Filter by name…" className="/* … */" />
        <div className="/* sort toggle */">
          <button type="button" x-on-click="setDex" className="/* … */">Dex #</button>
          <button type="button" x-on-click="setAz" className="/* … */">A–Z</button>
        </div>
        <span x-text="countLabel" className="/* … */" />
      </div>
      <div className="/* responsive card grid */">
        <a x-for="c in filtered by c.id" x-bind-href="c.detailHref" className="/* card */">
          <span x-text="c.num" className="/* … */" />
          <img x-bind-src="c.artwork" x-bind-alt="c.displayName" loading="lazy" className="/* … */" />
          <div x-text="c.displayName" className="/* … */" />
        </a>
      </div>
    </section>
  )
}
```
Notes: `x-for="c in filtered by c.id"` is keyed (0.1.28). `x-props={data}` → emitted `x-props="{{ (data) | e }}"`.
The `<input>` is outside the `x-for` list. Do NOT add a local `const` above the default's return (single-return).

**Gate:** build green; browser smoke — 151 cards render; typing filters instantly; **capture a surviving
card's `<img>` element identity is unchanged across a keystroke** (DOM-identity proof of keyed reconcile);
A–Z reorders without rebuilding; `countLabel` updates.

---

## Slice 4 — Detail (`DetailPage` + `detailLoader` + `AddToTeamButton`)
- `detailLoader`: port the backup's detailLoader logic (fetchPokemon/Species/Evolution), but replace
  design-token style values with hex (`heroBg` gradient from `TYPE_COLOR[primary]`; stat bar colors via
  `statBucket` → inline `style` color from a small map; type badge colors inline). Keep `notFound(empty)`
  → 404, `addProps` JSON for AddToTeamButton, chrome fields, `evolution`/`stats`/`abilities`/`types` VMs.
- `DetailPage`: hero (artwork + name + num + types + genus + flavor), stat bars (`.map()`,
  `style={{width:st.barWidth, background:st.color}}`), abilities, evolution chain (`.map()` + inline
  conditionals for level/current), `<AddToTeamButton native data={addProps} />`. Restyle Tailwind.
- `AddToTeamButton`: port behavior (writes `pokedex.team` store via the team action/store); restyle.

**Gate:** build green; detail renders; bad name → 404 page; AddToTeam updates the team dock.

---

## Slice 5 — Type chart + Team dock
- `typeChartLoader`: port VERBATIM (nested rows/cells VM), but cell colors → inline `style` or Tailwind
  utility classes (super/weak/none). Keep chrome fields.
- `TypeChart`: nested `.map()` grid (`rows.map(r => r.cells.map(c => …))`); restyle Tailwind (keep cells
  as grid items). Cell bg via inline `style` from a loader color or a static utility per bucket.
- `TeamBuilder.tsx`: port the React island (reads `pokedex.team` defineStore, add/remove, persists);
  restyle Tailwind as a slide-in dock/drawer. **Stays React; keys list with React `key=`. Do NOT convert
  to keyed x-for.**

**Gate:** build green; type chart renders 19×19; team dock opens, add/remove syncs across pages.

---

## Slice 6 — README + full smoke + verify
- `README.md`: short — what the example demonstrates (the capability list + where each lives).
- Full browser smoke pass (all 4 pages, theme persist across reload, SPA nav + NavPreloader, DexFilter
  keyed reconcile DOM-identity, team sync).
- `git diff --stat` scope check: ONLY `example/pokedex/**` + the two spec/plan docs + `.gitignore`. No
  framework/runtime/compiler files. `bun run typecheck:treaty` 0. Framework integration suite: run the
  native-island/cli-build tests; confirm no NEW failures vs the known pre-existing `/native-islands`
  degrade.

---

## Risks / BLOCKED fallbacks (global)
- **A native page construct gets rejected at build** → fall back to the backup's known-good shape for that
  page and re-skin incrementally (the backup compiled). Do NOT edit the compiler.
- **`@custom-variant` rejected** → `@variant` → explicit `[data-mode="dark"]` layer (slice 1 records it).
- **DexFilter x-props too large** → cap dataset (e.g. 60) and keep `countLabel` honest (no silent trunc).
- **Tailwind class not generated** (runtime-built string) → it must be a literal in a scanned file; move
  dynamic values to inline `style`. Never rely on a runtime-concatenated Tailwind class.
- If ANY of these needs a framework change to resolve → STOP and escalate (spec forbids framework edits).
