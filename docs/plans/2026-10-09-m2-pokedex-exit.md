# M2e — trimmed pokedex, server e2e, bench, release dry run, exit report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` after `m2c-napi-package` (PR in review, lane `/Users/detoro/code/brust-lane-m2c-napi-package` @2022434) and `m2x-minijinja-3` merge

**Goal:** `examples/pokedex` is the M2 dogfood (spec S13): five routes served by `brust build && brust start` from a committed offline dataset, every component an ordinary React function with hooks; `tests/server/` proves spec §10 from the outside (fetch) plus ONE real-Chromium hydration test; `bench/` measures the three probes on v2 and on the 0.1.x pokedex and writes the comparison; `release.yml` builds the six-target addon and dry-runs the npm publish; `docs/plans/m2-exit-report.md` is generated from pinned sets and diffed in CI.

**Architecture:** the app is plain files under `examples/pokedex/` (`routes.tsx` with `defineRoutes` from `@brust/core/routes`, `lib/` loaders over a JSON snapshot, `pages/` + `components/` as React functions); the build/serve path is entirely the m2c package (`packages/brust/bin/brust`), untouched here. Tests spawn that CLI exactly as `packages/brust/test/e2e.test.ts` does. The bench is one Bun script (`bench/run.ts`) driving `oha` against two spawned servers. The exit report is a pure function `renderExitReport(inputs)` over pinned sets + a fresh `dist/manifest.json` + the committed `bench/RESULTS.json` + the ledger file; `scripts/m2-exit/run.ts` writes it, `exit.test.ts` asserts the committed file equals a fresh render and that the exit criteria hold.

**Tech Stack:** Bun 1.4.2 (`bun test`, `Bun.spawn`), React 19 (`react`/`react-dom` from the workspace), `@brust/core` (m2c), `playwright` (library API only, Chromium; the ONLY new dependency), `oha` 1.11 on PATH for the bench (manual), `@tailwindcss/cli` v4 run ONCE by hand (output committed), `@napi-rs/cli` 3 (already a devDependency of `packages/brust`), `cargo-zigbuild` + zig 0.13.0 in CI cross legs.

**Spec:** `docs/design/2026-10-09-m2-server-design.md` §8 (CLI/config), §9 (S13), §10 (S14), S6 amendments block (lines 156–211), S7/S9; map `docs/plans/2026-10-09-m2-map.md` "Decisions for wave 3" (binding) and contracts 1–9.

> **Line-number note:** every `packages/brust/src/*.ts:<line>` citation below is from the m2c lane @2022434. After the m2c PR merges to `v2`, re-locate symbols by name (`run.ts` `run()`, `cli.ts` `main()`, `routes.ts` `defineRoutes`/`notFound`/`LoaderReq`, `build/index.ts` `runBuild`, `build/manifest.ts` `ManifestJson`); do not trust the numbers.

## Decisions (final, from the map; this plan argues from them)

- **D1 offline dataset** — `examples/pokedex/data/pokedex.json` (151 Pokémon + 18 type relations) produced once by `examples/pokedex/scripts/snapshot.ts` (network, by hand) and committed; `lib/pokeapi.ts` keeps the 0.1.x export names and signatures (`fetchList`, `fetchPokemon`, `fetchSpecies`, `fetchEvolution`, `fetchTypeRelations`, `artwork`, `cap`, `pad`, `TYPE_COLOR`, `STAT_LABEL`, `statBucket`, `ALL_TYPES`) but reads the snapshot. No network at build, test or bench time.
- **D2 hooks port** (map table): `ThemeToggle` = `useState` + `useEffect` → `document.documentElement.dataset.mode`; `HeroSearch` = controlled input + `useId` (label/input pair), GET form to `/pokedex?q=`; `DexFilter` = `useState` filter/sort via a module helper over a keyed list of static `<DexCard>` rows; `NavLink` static `<a>` with `active` computed in the loader from `path`; `Breadcrumb` static; `TeamBuilder` = `useReducer` → react tier, SSR + idle hydration, roster seeded from `teamInitial`, add/remove local only; `AddToTeamButton`, actions, stores, `NavPreloader`, `lucide-react` dropped; `TypeChart` kept as a static grid; `AppLayout` returns `<html lang data-mode>…<Outlet/>…</html>`.
- **D3 route tree** (5 routes = the manifest count T2 asserts): under `AppLayout`: `/` (homeLoader), `/pokedex` (browseLoader, reads `req.search.q`), `/pokemon/{name}` (detailLoader → `notFound` for an unknown name; `cache: { ttl_seconds: 60, tags: ['pokemon'], bypass: 'query(nocache)' }`), `/type-chart` (typeChartLoader; `cache: { ttl_seconds: 3600, tags: ['types'] }`); and a ROOT-level `{ path: '*', Component: NotFoundPage }` OUTSIDE the layout (its own static `<html>` document). Reason: spec §10 wants "a static route makes 0 Bun calls on first request" and S9 "a route whose every component is static gets no scripts"; every chain under `AppLayout` carries the `TeamBuilder` ssr job and the runtime, so the only route that can genuinely hold both assertions is a static full-document catch-all. Said so in the e2e test names.
- **D4 jobs the app exercises on purpose:** `DetailPage` calls two module helpers (`fmtHeight`, `fmtWeight`) → its own precompute job (`detailPage` "has jobs", the bench's "loader + 1 job" probe); `TypeBadge` (helper `tint`/`label` from `lib/format.ts`) is rendered per row of a `types: string[]` prop on BOTH `HomePage` ("browse by type", all 18) and `DetailPage` (the Pokémon's 1–2 types) → the per-instance child job (`__typeBadge_<k>` array, F34) AND a job-cache HIT across two routes with the same component + inputs (`{type:'electric'}` on `/pokemon/pikachu` after `/`); `TeamBuilder` sits in `AppLayout` with a constant `teamInitial` seed, so its ssr job is a HIT on every page after the first. `DexCard` has NO job (its list is a state-derived value, not a props path — a per-row child job there would be the build error `instance-list-path`).
- **D5 Chromium:** one test file, `playwright` library API (no `@playwright/test` runner), `chromium` only, `bunx playwright install --with-deps chromium` in the CI `server` job. External artwork hosts are stubbed in-page (a 1×1 PNG) so an airgapped CI never logs resource errors.
- **D6 bench:** `bench/run.ts` ports `scripts/benchmark.ts` (oha JSON, `BENCH_CONN`/`BENCH_DUR`/`BENCH_WARMUP`); probes A `/type-chart` (L1 HIT after warm-up on v2; a full render on 0.1.x, which has no cache there — reported as is), B `/pokemon/<name>?nocache=1` with `--rand-regex-url` over the 151 names (L1 bypassed: loader every request, jobs from the job cache after warm-up; 0.1.x: same regex, no `nocache`, it has no L1), C `/` (renders `TeamBuilder` on both). Bar: v2 `rps` ≥ 0.1.x `rps` on every probe. The bench is manual; CI only syntax-checks the script.
- **D7 release:** `release.yml` = the 0.1.x matrix (3 native + 3 zig cross legs) building `crates/brust-napi` through `packages/brust`'s napi script; a `dry-run` job on `workflow_dispatch` assembles `npm/<plat>` and runs `bun publish --dry-run` for `@brust/core`, `@brust/runtime-dom` and the six `@brust/native-<plat>`; the tag-gated `publish` job is kept and stays a human action. `bun publish` (not `npm publish`) because `@brust/core` depends on `@brust/runtime-dom` and the six platform packages through `workspace:*` (so `bun install --frozen-lockfile` never asks the registry for unpublished names — the D5 404 trap of m2c) and only `bun publish` rewrites `workspace:*` to the real version. `scripts/release-bump.ts` bumps the 8 `version` fields atomically and verifies no `@brust/*` dependency is pinned to a literal version.
- **D8 exit report** generated by `scripts/m2-exit/run.ts` from pinned sets (`ROUTES`, `PROBES`, `LEDGER_ROWS`), a fresh `brust build` manifest, `bench/RESULTS.json` and the ledger's owner column; `exit.test.ts` pins the sets and checks the criteria; CI diffs the committed file.

## Global Constraints

- **Offline dataset.** Nothing under `examples/pokedex/{lib,pages,components}` performs network I/O; the only `fetch` lives in `scripts/snapshot.ts`, which is never imported by the app. `tests/server/*` and `bench/run.ts` must pass with the network off (the Chromium test stubs the artwork host).
- **No 0.1.x APIs.** No `brustjs*` import, no `native: true`, no `BrustPage`/`Island`/`isr`/`behavior`/`x-*` attributes, no `brustjs/store`/`navigation`, no `lucide-react` (an external component import would push a page to the react tier). Imports are `react`, `@brust/core`, `@brust/core/routes` and local files only.
- **React-free runtime.** Native/static pages ship only `runtime-<hex>.js` + their own chunks; React reaches the browser only through `react-teamBuilder_<id>-<hex>.js` and the shared react chunk the build emits. The e2e asserts the static catch-all ships NO script tag at all.
- **Generated files are never hand-edited:** `examples/pokedex/data/pokedex.json` (snapshot script), `examples/pokedex/public/app.css` (Tailwind CLI, command recorded in the file header comment and in `examples/pokedex/README.md`), `npm/*/package.json` (`napi create-npm-dirs`, then bumped only by `release-bump.ts`), `bench/RESULTS.{md,json}` (`bun run bench`), `docs/plans/m2-exit-report.md` (`bun scripts/m2-exit/run.ts`). CI diffs the exit report; a diff means a stale commit.
- **Bench bar:** v2 not slower than 0.1.x on any of the three probes (`rps`), measured fresh on one host in one run, deltas reported, host + Bun version + addon build mode recorded (perf memory: the bench lied 3×; macOS ≠ Linux). A run with `BRUST_01X_DIR` unset writes v2-only numbers and marks the bar `not measured`, never `met`.
- **Publishing is a human action.** This lane adds `workflow_dispatch` dry runs only. Nothing in this lane pushes a tag or runs `publish` without `--dry-run`; `release-bump.ts --release` refuses off the `v2` branch and still only tags.
- **Boundary:** `examples/pokedex/**`, `tests/server/**`, `bench/**`, `scripts/m2-exit/**`, `scripts/release-bump.ts`, `docs/plans/m2-exit-report.md`, `docs/plans/m1a-followups.md` (owner column of F34/F45 only), `.github/workflows/ci.yml` (`server` job steps only), `.github/workflows/release.yml`, `npm/**`, `package.json` (root: `workspaces` + `scripts` only), `bun.lock`, `packages/brust/package.json` (`private`, `files`, `publishConfig`, `optionalDependencies`, one script). **Boundary extension requested at claim time:** `packages/runtime-dom/package.json` loses `"private": true` and gains `files`/`publishConfig` (3 lines) so its dry run can run; if the lead refuses, T6 skips `@brust/runtime-dom` and the exit report says so (the generator reads the flag).
- Gates: `cd packages/brust && bun run build:debug` once (the addon), then `bun test tests/server/pokedex.test.ts`, `bun test tests/server/hydrate.chromium.test.ts`, `bun scripts/m2-exit/run.ts && git diff --exit-code docs/plans/m2-exit-report.md`, `bun test scripts/m2-exit`, `bun build --no-bundle bench/run.ts`. Commit per task; one PR from `lane/m2e-pokedex-exit` to `v2`.

## Review Focus

1. **A route that looks static but calls Bun** — the catch-all must make 0 loader and 0 job calls and ship no `<script`; `/type-chart`'s second request must be `x-brust-cache: HIT` with both counters unchanged. Pinned by T3 tests "catch-all is a static document" and "type-chart: one loader call, no job call, then HIT".
2. **Job cache key too coarse or too fine** — the shared `TypeBadge` job must HIT across `/` → `/pokemon/pikachu` (`job.hits` +≥2: the badge and the layout's ssr) while `detailPage` j0 MISSes exactly once per Pokémon (`job.misses` +1). Pinned by T3 "job cache HIT across two routes". A regression that hashes the whole context (never hits) or ignores inputs (wrong badge colour on bulbasaur) fails it.
3. **Per-row values painted in the wrong row** — bulbasaur's badges must read grass `#63bb5b` then poison `#ab6ac8` in document order; the browse grid must paint `#0001 Bulbasaur` … `#0151 Mew` in order. Pinned by T3 "per-row child values".
4. **Server HTML ≠ client first paint for the react child** — only Chromium sees a hydration mismatch (F45): the test fails on any `console.error` (React logs mismatches there) and on a missing `data-hydrated="1"`. Pinned by T3 `hydrate.chromium.test.ts`. The dataset stub makes the test deterministic; a test that passes only with network is a bug.
5. **A bench or release that reports green without doing the work** — `bench/run.ts` refuses to run without `oha` and without a release addon (`packages/brust/native/brust.*.node` built with `bun run build`, not `build:debug`), and prints `bar: not measured` without `BRUST_01X_DIR`; `release.yml`'s dry-run job fails if the packed `@brust/core` tarball still contains the string `workspace:`; `release-bump.ts` fails unless exactly 8 refs verify. Pinned by T4 step 4, T6 steps 3 and 5, and the `exit.test.ts` bar check (which reads the committed JSON and refuses `met` when any probe lacks a 0.1.x number).

---

### Task 1: Offline dataset — snapshot script, `lib/pokeapi.ts`, unit test

**Files:**
- Create: `examples/pokedex/package.json`, `examples/pokedex/tsconfig.json`, `examples/pokedex/scripts/snapshot.ts`, `examples/pokedex/data/pokedex.json` (generated, committed), `examples/pokedex/lib/pokeapi.ts`, `examples/pokedex/lib/types.ts`, `examples/pokedex/test/snapshot.test.ts`
- Modify: `package.json` (root `workspaces`), `bun.lock`

**Interfaces:**
- Consumes: PokeAPI v2 (snapshot script only, by hand).
- Produces:
  - `data/pokedex.json`: `{ "generatedAt": string, "pokemon": SnapPokemon[151], "types": Record<TypeName, Record<TypeName, number>> }` with `SnapPokemon = { id, name, types: string[], stats: {name, base}[], artwork, genus, flavorText, height, weight, abilities: string[], evolution: {id, name, minLevel: number|null}[] }`. One English flavour text per Pokémon (first `en` entry, whitespace-collapsed) keeps the file ≈110 KB (bar: < 600 KB, asserted by the test).
  - `lib/pokeapi.ts` exports, unchanged names/signatures from 0.1.x: `fetchList(offset, limit): Promise<{results:{id,name}[], total}>`, `fetchPokemon(name): Promise<RawPokemon|null>`, `fetchSpecies(id): Promise<RawSpecies>` (`evolutionUrl` now carries the Pokémon id as a string — the key `fetchEvolution` accepts), `fetchEvolution(key): Promise<RawEvolutionStage[]>`, `fetchTypeRelations(type): Promise<Record<string, number>>`, `artwork`, `cap`, `pad`, `TYPE_COLOR`, `STAT_LABEL`, `statBucket`, `ALL_TYPES`. All `fetch*` stay `async` so `lib/loaders.ts` ports unchanged apart from imports.

- [ ] **Step 1: Workspace membership**

Root `package.json` → `"workspaces": ["packages/*", "examples/*", "npm/*"]` (the `npm/*` entry is used by T6; harmless while empty). Create `examples/pokedex/package.json`:
```json
{
  "name": "@brust/example-pokedex",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "brust build routes.tsx", "start": "brust start", "snapshot": "bun scripts/snapshot.ts", "test": "bun test" },
  "dependencies": { "@brust/core": "workspace:*", "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "@types/bun": "^1.4.0", "@types/react": "^19.2.0", "playwright": "<pin: output of `bunx playwright --version` at lane start, e.g. 1.58.0>", "typescript": "^5.9.0" }
}
```
`tsconfig.json`: `{ "compilerOptions": { "jsx": "react-jsx", "module": "ESNext", "moduleResolution": "bundler", "strict": true, "noEmit": true, "resolveJsonModule": true, "types": ["bun-types"] } }`.
Run: `bun install` (updates `bun.lock`; `playwright` is pinned EXACTLY, no caret — the Chromium build it downloads must match in CI).

- [ ] **Step 2: Write the failing test**

```ts
// examples/pokedex/test/snapshot.test.ts
import { expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import snap from '../data/pokedex.json'
import { ALL_TYPES, fetchEvolution, fetchPokemon, fetchSpecies, fetchTypeRelations } from '../lib/pokeapi'

test('snapshot: 151 Pokémon in dex order, 18 type relations, under 600 KB', () => {
  expect(snap.pokemon).toHaveLength(151)
  expect(snap.pokemon.map((p) => p.id)).toEqual(Array.from({ length: 151 }, (_, i) => i + 1))
  expect(Object.keys(snap.types).sort()).toEqual([...ALL_TYPES].sort())
  expect(statSync(join(import.meta.dir, '../data/pokedex.json')).size).toBeLessThan(600 * 1024)
})

test('pikachu reads from the snapshot with the 0.1.x shapes', async () => {
  const p = await fetchPokemon('pikachu')
  expect(p).toMatchObject({ id: 25, name: 'pikachu', types: ['electric'] })
  expect(p!.stats.map((s) => s.name)).toEqual(['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'])
  const s = await fetchSpecies(25)
  expect(s.genus).toBe('Mouse Pokémon')
  expect(await fetchEvolution(s.evolutionUrl)).toEqual([{ id: 172, name: 'pichu', minLevel: null }, { id: 25, name: 'pikachu', minLevel: null }, { id: 26, name: 'raichu', minLevel: null }])
  expect(await fetchTypeRelations('electric')).toMatchObject({ water: 2, flying: 2, ground: 0, grass: 0.5 })
  expect(await fetchPokemon('nothing')).toBeNull()
})
```
Run: `cd examples/pokedex && bun test` — Expected: FAIL (`Cannot find module '../data/pokedex.json'`).

- [ ] **Step 3: The snapshot script** (network; run by hand; output committed)

```ts
// examples/pokedex/scripts/snapshot.ts — run ONCE with network: `bun run snapshot`. Writes data/pokedex.json.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const API = 'https://pokeapi.co/api/v2'
const ALL_TYPES = ['normal','fire','water','electric','grass','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy']
const idFromUrl = (url: string) => Number(/\/(\d+)\/?$/.exec(url)![1])
const clean = (s: string) => s.replace(/[\n\f\r]+/g, ' ').trim()
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`)
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return (await r.json()) as T
}
// biome-ignore lint/suspicious/noExplicitAny: PokeAPI JSON
type J = any
async function chain(url: string): Promise<{ id: number; name: string; minLevel: number | null }[]> {
  const data = await (await fetch(url)).json() as J
  const out: { id: number; name: string; minLevel: number | null }[] = []
  let node = data.chain
  while (node) {                                   // linear walk, first branch (0.1.x rule)
    out.push({ id: idFromUrl(node.species.url), name: node.species.name, minLevel: node.evolution_details?.[0]?.min_level ?? null })
    node = node.evolves_to?.[0]
  }
  return out
}
const pokemon = []
for (let id = 1; id <= 151; id++) {
  const p = await get<J>(`/pokemon/${id}`)
  const s = await get<J>(`/pokemon-species/${id}`)
  pokemon.push({
    id, name: p.name,
    types: p.types.map((t: J) => t.type.name),
    stats: p.stats.map((st: J) => ({ name: st.stat.name, base: st.base_stat })),
    artwork: p.sprites?.other?.['official-artwork']?.front_default ?? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`,
    genus: s.genera.find((g: J) => g.language.name === 'en')?.genus ?? '',
    flavorText: clean(s.flavor_text_entries.find((e: J) => e.language.name === 'en')?.flavor_text ?? ''),
    height: p.height, weight: p.weight,
    abilities: p.abilities.map((a: J) => a.ability.name),
    evolution: await chain(s.evolution_chain.url),
  })
  process.stderr.write(`\r${id}/151`)
}
const types: Record<string, Record<string, number>> = {}
for (const t of ALL_TYPES) {
  const d = await get<J>(`/type/${t}`)
  const rel: Record<string, number> = {}
  for (const x of d.damage_relations.double_damage_to) rel[x.name] = 2
  for (const x of d.damage_relations.half_damage_to) rel[x.name] = 0.5
  for (const x of d.damage_relations.no_damage_to) rel[x.name] = 0
  types[t] = rel
}
writeFileSync(join(import.meta.dir, '../data/pokedex.json'), `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), pokemon, types }, null, 1)}\n`)
console.log('\nwrote data/pokedex.json')
```
Run: `cd examples/pokedex && bun run snapshot` — Expected: `wrote data/pokedex.json`; `ls -la data/pokedex.json` ≈ 110 KB. Commit the JSON.

- [ ] **Step 4: `lib/pokeapi.ts` over the snapshot** (same exports as 0.1.x `example/pokedex/lib/pokeapi.ts`)

```ts
// examples/pokedex/lib/pokeapi.ts — the 0.1.x helper surface, served from data/pokedex.json (no network).
import snap from '../data/pokedex.json'

export interface RawPokemon { id: number; name: string; types: string[]; stats: { name: string; base: number }[]; height: number; weight: number; abilities: string[]; artwork: string }
export interface RawSpecies { flavorText: string; genus: string; evolutionUrl: string }
export interface RawEvolutionStage { id: number; name: string; minLevel: number | null }

const byName = new Map(snap.pokemon.map((p) => [p.name, p]))
const byId = new Map(snap.pokemon.map((p) => [p.id, p]))

export const artwork = (id: number): string => byId.get(id)?.artwork ?? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`
export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s)
export const pad = (n: number): string => `#${String(n).padStart(4, '0')}`
export const TYPE_COLOR: Record<string, string> = { normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' }
export const STAT_LABEL: Record<string, string> = { hp: 'HP', attack: 'Atk', defense: 'Def', 'special-attack': 'Sp.Atk', 'special-defense': 'Sp.Def', speed: 'Spd' }
export const statBucket = (base: number): string => (base >= 100 ? 'hi' : base >= 60 ? 'mid' : base >= 35 ? 'low' : 'min')
export const ALL_TYPES = ['normal','fire','water','electric','grass','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy']

export async function fetchList(offset: number, limit: number) {
  return { results: snap.pokemon.slice(offset, offset + limit).map((p) => ({ id: p.id, name: p.name })), total: snap.pokemon.length }
}
export async function fetchPokemon(name: string): Promise<RawPokemon | null> {
  const p = byName.get(name)
  return p ? { id: p.id, name: p.name, types: p.types, stats: p.stats, height: p.height, weight: p.weight, abilities: p.abilities, artwork: p.artwork } : null
}
/** `evolutionUrl` is the Pokémon id as a string: the key `fetchEvolution` reads (0.1.x carried a URL). */
export async function fetchSpecies(id: number): Promise<RawSpecies> {
  const p = byId.get(id)
  return p ? { flavorText: p.flavorText, genus: p.genus, evolutionUrl: String(id) } : { flavorText: '', genus: '', evolutionUrl: '' }
}
export async function fetchEvolution(key: string): Promise<RawEvolutionStage[]> {
  return key ? (byId.get(Number(key))?.evolution ?? []) : []
}
export async function fetchTypeRelations(type: string): Promise<Record<string, number>> {
  return (snap.types as Record<string, Record<string, number>>)[type] ?? {}
}
```
`lib/types.ts`: copy 0.1.x `lib/types.ts` minus `TeamMember.addedAt`, `AddTeamProps`, `DetailData.addProps`, `ChromeData.teamProps`/`themeLabel`; `ChromeData` becomes `{ title; crumb; mode: 'dark'|'light'; nav: NavItem[]; teamInitial: TeamMember[] }` with `NavItem = { href; label; active: boolean }`; `HomeData` gains `types: string[]`; `DetailData` gains `height: number; weight: number; typeNames: string[]` (raw inputs for the jobs, D4); `BrowseData` gains `q: string`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd examples/pokedex && bun test` — Expected: `2 pass, 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock examples/pokedex/package.json examples/pokedex/tsconfig.json examples/pokedex/scripts/snapshot.ts examples/pokedex/data/pokedex.json examples/pokedex/lib/pokeapi.ts examples/pokedex/lib/types.ts examples/pokedex/test/snapshot.test.ts
git commit -m "feat(pokedex): offline PokeAPI snapshot (151 + 18 type relations) behind the 0.1.x helper surface"
```

---

### Task 2: The app — routes, loaders, pages, components, prebuilt CSS, build smoke

**Files:**
- Create: `examples/pokedex/routes.tsx`, `examples/pokedex/brust.toml`, `examples/pokedex/README.md`, `examples/pokedex/lib/loaders.ts`, `examples/pokedex/lib/format.ts`, `examples/pokedex/lib/filter.ts`, `examples/pokedex/pages/{HomePage,BrowsePage,DetailPage,TypeChart,NotFoundPage}.tsx`, `examples/pokedex/components/{AppLayout,NavLink,ThemeToggle,HeroSearch,DexFilter,DexCard,TypeBadge,Breadcrumb,TeamBuilder}.tsx`, `examples/pokedex/styles/app.css` (Tailwind input), `examples/pokedex/public/app.css` (generated, committed), `examples/pokedex/public/favicon.svg` (copied from 0.1.x), `examples/pokedex/test/build.test.ts`
- No `index.ts`: `brust start` is the entry (spec §8); `dist/index.js` is generated by the build.

**Interfaces:**
- Consumes: `defineRoutes`, `Outlet`, `notFound`, `LoaderCtx`, `LoaderReq`, `Verdict` from `@brust/core/routes` (`packages/brust/src/routes.ts:26-38,113-117,178-180`); `brust build` (`cli.ts:61-74`), manifest shape `ManifestJson` (`build/manifest.ts:53-59`); config precedence (`config.ts:1-9`).
- Produces: the five-route app; the loader context keys every template reads (below); `dist/manifest.json` with routes `r1..r4` under `r0` (AppLayout) and `r5` (`*`), components `appLayout_*` (native or static — the layout has no hooks itself; the tier is whatever the compiler decides for a parent of hook-bearing inlined children, and the e2e asserts behaviour, not the tier), `detailPage_*` (native, `jobs: [j0 precompute inputs ["height","weight"]]` + a child record `typeBadge_* per-row:typeNames` + the layout-owned island), `teamBuilder_*` (react, `client: client/react-teamBuilder_*-<hex>.js`), `notFoundPage_*` (static, `client: null`).

- [ ] **Step 1: Write the failing build smoke test**

```ts
// examples/pokedex/test/build.test.ts — `brust build` succeeds and the manifest has the S13 shape.
import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const bin = join(app, '../../packages/brust/bin/brust')

test('brust build: 5 routes; detailPage has a job and a per-row TypeBadge; teamBuilder is react with a chunk; the catch-all is static', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', 'dist-test'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  const m = await Bun.file(join(app, 'dist-test/manifest.json')).json()
  expect(m.routes.map((r: { pattern: string }) => r.pattern)).toEqual(['/', '/pokedex', '/pokemon/{name}', '/type-chart', '*'])
  const detail = m.routes.find((r: { pattern: string }) => r.pattern === '/pokemon/{name}')
  expect(detail.cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['pokemon'] })
  const comp = (prefix: string) => Object.entries(m.components).find(([id]) => id.startsWith(`${prefix}_`))![1] as Record<string, unknown>
  const d = comp('detailPage') as { tier: string; jobs: { kind: string; inputs: string[] }[]; children: { id: string; instances: string }[] }
  expect(d.tier).toBe('native')
  expect(d.jobs.some((j) => j.kind === 'precompute' && j.inputs.includes('height') && j.inputs.includes('weight'))).toBe(true)
  expect(d.children.some((c) => c.id.startsWith('typeBadge_') && c.instances === 'per-row:typeNames')).toBe(true)
  const layout = comp('appLayout') as { jobs: { kind: string; target?: string }[] }
  expect(layout.jobs.some((j) => j.kind === 'ssr' && j.target?.startsWith('teamBuilder_'))).toBe(true)
  const team = comp('teamBuilder') as { tier: string; client: string }
  expect(team.tier).toBe('react')
  expect(team.client).toMatch(/^client\/react-teamBuilder_[0-9a-f]{8}-[0-9a-f]{10}\.js$/)
  const nf = comp('notFoundPage') as { tier: string; client: string | null }
  expect(nf).toMatchObject({ tier: 'static', client: null })
  rmSync(join(app, 'dist-test'), { recursive: true, force: true })
}, 120_000)
```
Run: `cd packages/brust && bun run build:debug && cd ../../examples/pokedex && bun test test/build.test.ts` — Expected: FAIL (`routes.tsx` not found → `error route-entry …`).

- [ ] **Step 2: Routes and config**

```tsx
// examples/pokedex/routes.tsx
import { defineRoutes } from '@brust/core/routes'
import AppLayout from './components/AppLayout'
import { browseLoader, detailLoader, homeLoader, typeChartLoader } from './lib/loaders'
import BrowsePage from './pages/BrowsePage'
import DetailPage from './pages/DetailPage'
import HomePage from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'
import TypeChart from './pages/TypeChart'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage, loader: homeLoader },
      { path: '/pokedex', Component: BrowsePage, loader: browseLoader },
      // L1 for 60 s by tag; `?nocache=1` bypasses L1 (bench probe B measures the miss path).
      { path: '/pokemon/{name}', Component: DetailPage, loader: detailLoader, cache: { ttl_seconds: 60, tags: ['pokemon'], bypass: 'query(nocache)' } },
      { path: '/type-chart', Component: TypeChart, loader: typeChartLoader, cache: { ttl_seconds: 3600, tags: ['types'] } },
    ],
  },
  // Outside the layout on purpose (D3): a static full document → 0 Bun calls, no scripts.
  { path: '*', Component: NotFoundPage },
])
```
`brust.toml`: `[server]\naddress = "127.0.0.1"\nport = 1337\n` (tests override with `--port 0`; `BRUST_PORT` env wins over both, `config.ts:51-52`).

- [ ] **Step 3: Loaders** (port of 0.1.x `lib/loaders.ts`; `brustjs/routes` → `@brust/core/routes`; `chrome()` gains `path`)

```ts
// examples/pokedex/lib/loaders.ts
import { type LoaderCtx, type LoaderReq, notFound, type Verdict } from '@brust/core/routes'
import { ALL_TYPES, artwork, cap, fetchEvolution, fetchList, fetchPokemon, fetchSpecies, fetchTypeRelations, pad, STAT_LABEL, statBucket, TYPE_COLOR } from './pokeapi'
import type { BrowseData, DetailData, HomeData, TeamMember, TypeChartCellVM, TypeChartData, TypeChartRowVM } from './types'

const FEATURED = [{ id: 1, name: 'bulbasaur' }, { id: 4, name: 'charmander' }, { id: 7, name: 'squirtle' }, { id: 25, name: 'pikachu' }, { id: 39, name: 'jigglypuff' }, { id: 94, name: 'gengar' }, { id: 143, name: 'snorlax' }, { id: 150, name: 'mewtwo' }]
/** Constant on every page, so the TeamBuilder ssr job is one job-cache entry site-wide (D4). */
export const TEAM_SEED: TeamMember[] = [
  { id: 1, name: 'bulbasaur', displayName: 'Bulbasaur', types: ['grass', 'poison'], artwork: artwork(1), num: '#0001' },
  { id: 4, name: 'charmander', displayName: 'Charmander', types: ['fire'], artwork: artwork(4), num: '#0004' },
]
const NAV = [{ href: '/', label: 'Home' }, { href: '/pokedex', label: 'Pokédex' }, { href: '/type-chart', label: 'Type chart' }]
const card = (p: { id: number; name: string }) => ({ id: p.id, name: p.name, displayName: cap(p.name), num: pad(p.id), artwork: artwork(p.id), detailHref: `/pokemon/${p.name}` })

/** Chrome every leaf returns: AppLayout reads it from the merged loader context (child keys win). */
const chrome = (req: LoaderReq, path: string, title: string, crumb: string) => ({
  title, crumb,
  mode: (req.cookies.mode === 'light' ? 'light' : 'dark') as 'light' | 'dark',
  nav: NAV.map((n) => ({ ...n, active: n.href === path })),
  teamInitial: TEAM_SEED,
})

export async function homeLoader({ req, path }: LoaderCtx): Promise<HomeData> {
  return { ...chrome(req, path, 'PokéDex · built with brust', 'Home'), featured: FEATURED.map(card), types: ALL_TYPES }
}
export async function browseLoader({ req, path }: LoaderCtx): Promise<BrowseData> {
  const q = (req.search.q ?? '').trim().toLowerCase()
  const { results } = await fetchList(0, 151)
  return { ...chrome(req, path, 'Pokédex · Browse', 'Pokédex'), q, items: results.filter((r) => !q || r.name.includes(q)).map(card) }
}
const BAR_COLOR: Record<string, string> = { hi: '#16a34a', mid: '#0ea5e9', low: '#f59e0b', min: '#ef4444' }
export async function detailLoader({ params, req, path }: LoaderCtx<{ name: string }>): Promise<DetailData | Verdict> {
  const name = params.name ?? ''
  const p = await fetchPokemon(name)
  if (!p) return notFound(emptyDetail(req, path, name))
  const species = await fetchSpecies(p.id)
  const evo = await fetchEvolution(species.evolutionUrl)
  const tint = TYPE_COLOR[p.types[0] ?? 'normal'] ?? '#888888'
  return {
    ...chrome(req, path, `${cap(p.name)} · PokéDex`, cap(p.name)),
    notFound: false, name: p.name, id: p.id, displayName: cap(p.name), num: pad(p.id), artwork: p.artwork,
    genus: species.genus, flavorText: species.flavorText,
    height: p.height, weight: p.weight,                       // raw: DetailPage's job formats them (D4)
    typeNames: p.types,                                       // TypeBadge per row (D4)
    heroBg: `linear-gradient(160deg, ${tint}33, transparent 70%)`,
    stats: p.stats.map((s) => ({ label: STAT_LABEL[s.name] ?? s.name, base: s.base, barWidth: `${Math.min(100, Math.round((s.base / 200) * 100))}%`, barColor: BAR_COLOR[statBucket(s.base)] ?? '#0ea5e9' })),
    statTotal: p.stats.reduce((a, s) => a + s.base, 0),
    abilities: p.abilities.map((a) => ({ displayName: cap(a), initial: a.charAt(0).toUpperCase(), iconColor: tint })),
    hasAbilities: p.abilities.length > 0,
    evolution: evo.map((s, i) => ({ id: s.id, displayName: cap(s.name), num: pad(s.id), artwork: artwork(s.id), detailHref: `/pokemon/${s.name}`, levelLabel: s.minLevel != null ? `Lv ${s.minLevel}` : '', isFirst: i === 0, showLevel: i > 0 && s.minLevel != null, isCurrent: s.id === p.id })),
    hasEvolution: evo.length > 1,
  }
}
function emptyDetail(req: LoaderReq, path: string, name: string): DetailData {
  return { ...chrome(req, path, `${cap(name)} · PokéDex`, cap(name)), notFound: true, name, id: 0, displayName: cap(name), num: '', artwork: '', genus: '', flavorText: '', height: 0, weight: 0, typeNames: [], heroBg: '', stats: [], statTotal: 0, abilities: [], hasAbilities: false, evolution: [], hasEvolution: false }
}
export async function typeChartLoader({ req, path }: LoaderCtx): Promise<TypeChartData> {
  // Port the 0.1.x row/cell builder verbatim (SHORT, CELL_CLASS, HEAD_BASE; loaders.ts:235-357 on main).
  const relations = await Promise.all(ALL_TYPES.map((t) => fetchTypeRelations(t)))
  const rows: TypeChartRowVM[] = buildRows(relations)   // the 0.1.x code, unchanged
  return { ...chrome(req, path, 'PokéDex · type chart', 'Type chart'), rows }
}
```
(`buildRows` is the 0.1.x `typeChartLoader` body lines 287–357 moved into a function; `TypeChartCellVM`/`TypeChartRowVM` unchanged.)

`lib/format.ts` (module helpers → jobs):
```ts
export const fmtHeight = (dm: number) => `${(dm / 10).toFixed(1)} m`
export const fmtWeight = (hg: number) => `${(hg / 10).toFixed(1)} kg`
export const tint = (type: string) => ({ normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' } as Record<string, string>)[type] ?? '#888888'
export const label = (type: string) => type.charAt(0).toUpperCase() + type.slice(1)
```
`lib/filter.ts` (bundled into DexFilter's client chunk AND its precompute job):
```ts
import type { DexCard } from './types'
export function filterSort(items: DexCard[], q: string, az: boolean): DexCard[] {
  const needle = q.trim().toLowerCase()
  const out = needle ? items.filter((c) => c.name.includes(needle)) : items.slice()
  return az ? out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : out
}
```

- [ ] **Step 4: Components** (every file in full; classes trimmed to what the stylesheet needs)

```tsx
// components/AppLayout.tsx — the document (S9): plain <html>, <Outlet/> for the leaf, TeamBuilder as a react child.
import { Outlet } from '@brust/core/routes'
import type { NavItem, TeamMember } from '../lib/types'
import NavLink from './NavLink'
import TeamBuilder from './TeamBuilder'
import ThemeToggle from './ThemeToggle'

export default function AppLayout(props: { title: string; mode: 'dark' | 'light'; nav: NavItem[]; teamInitial: TeamMember[] }) {
  return (
    <html lang="en" data-mode={props.mode}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href="/public/favicon.svg" />
        <link rel="stylesheet" href="/public/app.css" />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80">
          <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4">
            <a href="/" className="mr-2 flex items-center gap-2 no-underline"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-extrabold text-white">P</span><span className="text-base font-extrabold">PokéDex</span></a>
            {props.nav.map((n) => <NavLink key={n.href} href={n.href} label={n.label} active={n.active} />)}
            <div className="ml-auto"><ThemeToggle mode={props.mode} /></div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8"><Outlet /></main>
        <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-400 dark:border-slate-800">Built with brust · data: PokeAPI snapshot</footer>
        <TeamBuilder teamInitial={props.teamInitial} />
      </body>
    </html>
  )
}
```
```tsx
// components/NavLink.tsx — static; `active` is computed in the loader from `path` (no client nav in M2).
const BASE = 'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
const ACTIVE = 'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold text-brand-600 bg-brand-50 dark:text-brand-50 dark:bg-brand-600/20'
export default function NavLink(props: { href: string; label: string; active: boolean }) {
  return <a href={props.href} data-active={props.active ? '1' : '0'} className={props.active ? ACTIVE : BASE}>{props.label}</a>
}
```
```tsx
// components/ThemeToggle.tsx — useState + useEffect (spec §9 example). No cookie write (actions are M3): the
// loader still reads `mode` from the cookie for the first paint; the toggle is per page view.
import { useEffect, useState } from 'react'
export default function ThemeToggle(props: { mode: 'dark' | 'light' }) {
  const [mode, setMode] = useState(props.mode)
  useEffect(() => { document.documentElement.dataset.mode = mode }, [mode])
  return (
    <button type="button" aria-label="Toggle theme" data-testid="theme-toggle" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium dark:border-slate-700">
      {mode === 'dark' ? 'Light' : 'Dark'}
    </button>
  )
}
```
```tsx
// components/HeroSearch.tsx — controlled input + useId; a plain GET form to /pokedex?q= (no SPA navigate).
import { useId, useState } from 'react'
export default function HeroSearch() {
  const id = useId()
  const [q, setQ] = useState('')
  return (
    <form action="/pokedex" method="get" className="mx-auto mt-8 flex w-full max-w-md items-center gap-2 rounded-2xl bg-white/95 p-2 shadow-lg dark:bg-slate-900/90">
      <label htmlFor={id} className="sr-only">Search the Pokédex</label>
      <input id={id} name="q" type="search" placeholder="Search the Pokédex…" value={q} onChange={(e) => setQ(e.target.value)}
        className="min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2 text-sm text-slate-900 dark:text-white" />
      <button type="submit" className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white">Search</button>
    </form>
  )
}
```
```tsx
// components/TypeBadge.tsx — one helper-backed job; rendered per row on HomePage AND DetailPage (D4).
import { label, tint } from '../lib/format'
export default function TypeBadge(props: { type: string }) {
  return <span data-type={props.type} style={{ background: tint(props.type) }} className="rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">{label(props.type)}</span>
}
```
```tsx
// components/DexCard.tsx — static per-row child (props only, no job: its list is state-derived, D4).
import type { DexCard as Card } from '../lib/types'
export default function DexCard(props: { card: Card }) {
  return (
    <a href={props.card.detailHref} data-dex={props.card.num} className="group flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-3 no-underline shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="self-start text-[11px] font-semibold tabular-nums text-slate-400">{props.card.num}</span>
      <img src={props.card.artwork} alt={props.card.displayName} loading="lazy" className="h-24 w-24 object-contain" />
      <div className="mt-1 text-sm font-semibold">{props.card.displayName}</div>
    </a>
  )
}
```
```tsx
// components/DexFilter.tsx — useState filter/sort; `filterSort` is a module helper so the first paint is a
// precompute job seeded with the initial state and the client recomputes on change (battery e-precompute-state).
import { useState } from 'react'
import { filterSort } from '../lib/filter'
import type { DexCard as Card } from '../lib/types'
import DexCard from './DexCard'
export default function DexFilter(props: { items: Card[] }) {
  const [q, setQ] = useState('')
  const [az, setAz] = useState(false)
  const shown = filterSort(props.items, q, az)
  return (
    <section>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input type="search" placeholder="Search Pokémon…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm sm:max-w-xs dark:border-slate-700 dark:bg-slate-900" />
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setAz(false)} className="rounded-l-xl border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700">Dex#</button>
          <button type="button" onClick={() => setAz(true)} className="rounded-r-xl border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700">A–Z</button>
          <span data-testid="count" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold tabular-nums dark:bg-slate-800">{shown.length} / {props.items.length}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {shown.map((c) => <DexCard key={c.id} card={c} />)}
      </div>
    </section>
  )
}
```
```tsx
// components/Breadcrumb.tsx — static (no nav store in M2).
export default function Breadcrumb(props: { crumb: string }) {
  return <b className="text-slate-600 dark:text-slate-300">{props.crumb}</b>
}
```
```tsx
// components/TeamBuilder.tsx — react tier on purpose (useReducer): SSR + idle hydration (S12). Roster is local state.
import { useReducer } from 'react'
import type { TeamMember } from '../lib/types'
type Action = { type: 'toggle' } | { type: 'remove'; id: number }
type State = { open: boolean; team: TeamMember[] }
const MAX = 6
function reducer(s: State, a: Action): State {
  if (a.type === 'toggle') return { ...s, open: !s.open }
  return { ...s, team: s.team.filter((m) => m.id !== a.id) }
}
export default function TeamBuilder(props: { teamInitial: TeamMember[] }) {
  const [s, dispatch] = useReducer(reducer, { open: false, team: props.teamInitial })
  return (
    <div className="fixed bottom-5 right-5 z-[200]">
      {s.open && (
        <div data-testid="team-panel" className="mb-3 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800"><span className="text-sm font-extrabold">My team</span><span className="ml-auto text-xs font-semibold">{s.team.length} / {MAX}</span></div>
          {s.team.length === 0 ? <div className="px-5 py-7 text-center text-xs text-slate-400">No Pokémon on your team yet.</div> : s.team.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
              <img src={m.artwork} alt={m.displayName} className="h-7 w-7 object-contain" />
              <a href={`/pokemon/${m.name}`} className="min-w-0 flex-1 text-xs font-semibold no-underline">{m.displayName}</a>
              <button type="button" aria-label="Remove" onClick={() => dispatch({ type: 'remove', id: m.id })} className="rounded p-1 text-slate-400">×</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={() => dispatch({ type: 'toggle' })} className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
        My team <span data-testid="team-count" className="rounded-full bg-white/25 px-2 py-0.5 text-xs font-extrabold">{s.team.length}</span>
      </button>
    </div>
  )
}
```
Pages (each a single return reading props; port the 0.1.x markup with `lucide-react` icons removed and these substitutions):
- `pages/HomePage.tsx`: `{ featured, types }: HomeData`; `<HeroSearch />` (no `native`); the featured strip as 0.1.x; "Browse by type" becomes `{types.map((t) => <a key={t} href="/pokedex"><TypeBadge type={t} /></a>)}` (per-row TypeBadge, D4); the "Built with brust" boxes become three text cards (native SSR routes, loaders + cache, react islands).
- `pages/BrowsePage.tsx`: `{ items, q }: BrowseData` → `<h1>Pokédex</h1>`, `{q && <p>Results for “{q}”</p>}`, `<DexFilter items={items} />`.
- `pages/DetailPage.tsx`: 0.1.x markup; `<Breadcrumb crumb={displayName} />`; the type chips become `{typeNames.map((t) => <TypeBadge key={t} type={t} />)}`; height/weight cells read `{fmtHeight(height)}` / `{fmtWeight(weight)}` (imports from `../lib/format` → the page's own precompute job); `AddToTeamButton` removed; the `notFound` branch unchanged (`No Pokémon named “{displayName}”`).
- `pages/TypeChart.tsx`: 0.1.x file verbatim (nested `.map()` grid, `style={{ background: c.bg }}`).
- `pages/NotFoundPage.tsx` (its own document, D3):
```tsx
export default function NotFoundPage() {
  return (
    <html lang="en" data-mode="dark"><head><meta charSet="utf-8" /><title>Not found · PokéDex</title><link rel="stylesheet" href="/public/app.css" /></head>
      <body className="min-h-screen bg-slate-50 dark:bg-slate-950"><main className="mx-auto max-w-md py-16 text-center"><div className="text-6xl font-black text-brand-500">404</div><h1 className="mt-4 text-2xl font-extrabold">Nothing here</h1><a href="/" className="mt-6 inline-block rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white no-underline">Back home</a></main></body>
    </html>
  )
}
```

- [ ] **Step 5: Prebuilt stylesheet** (one-off; command recorded)

`styles/app.css` (input, committed): the 0.1.x `app.css` with `@source "../**/*.tsx";` and the `theme-icon-*` rules dropped. Generate:
```bash
cd examples/pokedex && bunx @tailwindcss/cli@4 -i styles/app.css -o public/app.css --minify
```
Prepend to `public/app.css` the header comment `/* generated: bunx @tailwindcss/cli@4 -i styles/app.css -o public/app.css --minify — do not edit */`. Copy `example/pokedex/public/favicon.svg` from the 0.1.x repo. Record the command in `examples/pokedex/README.md` (build/start/snapshot/css sections, 30 lines).

- [ ] **Step 6: Run the build test to verify it passes**

Run: `cd examples/pokedex && bun test test/build.test.ts` — Expected: `1 pass`; stdout of the build lists no `warning` lines for `pages/*` or `components/*` (a `warning effect-deps` or `fragment-root` here is a porting mistake: fix the source, do not accept it).
Then the demo: `cd examples/pokedex && bun run build && bun run start` → `[brust] listening on 127.0.0.1:1337 …`, `[brust] ready (N workers)`; `curl -s localhost:1337/pokemon/pikachu | grep -c Pikachu` ≥ 1; Ctrl-C exits 0.

- [ ] **Step 7: Commit**

```bash
git add examples/pokedex
git commit -m "feat(pokedex): M2 trimmed port — five routes, hooks components, TeamBuilder react child, prebuilt css"
```

---

### Task 3: Server e2e (`tests/server/pokedex.test.ts`) and the Chromium hydration test

**Files:**
- Create: `tests/server/pokedex.test.ts`, `tests/server/hydrate.chromium.test.ts`, `tests/server/harness.ts`
- Modify: `.github/workflows/ci.yml` (`server` job: append steps), `package.json` (root scripts `server-test`)

**Interfaces:**
- Consumes: `packages/brust/bin/brust` (`build`/`start --port 0 --workers 2`), stdout lines `[brust] listening on <addr>` (`crates/brust-server/src/server/mod.rs:190`) and `[brust] ready (N workers)` (`run.ts:77`), `GET /_brust/cache/stats` → `{ l1: {hits,misses,len,capacity}, job: {hits,misses,len,capacity}, loader_calls, job_calls }` (`config.rs:137-142`, `cache/l1.rs:87-92`), header `x-brust-cache: HIT|MISS`.
- Produces: `tests/server/harness.ts` → `startPokedex(): Promise<{ base: string; stats(): Promise<Stats>; stop(): Promise<void> }>` (build once per process into `examples/pokedex/dist`, spawn, wait for ready, drain stdout; SIGINT then SIGKILL after 5 s — the m2c e2e pattern verbatim).

- [ ] **Step 1: Harness** (copy of `packages/brust/test/e2e.test.ts:8-58` as a module)

```ts
// tests/server/harness.ts
import { join } from 'node:path'
export const app = join(import.meta.dir, '../../examples/pokedex')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
export type Stats = { l1: { hits: number; misses: number }; job: { hits: number; misses: number }; loader_calls: number; job_calls: number }
export async function startPokedex() {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; out += dec.decode(value, { stream: true }) } })()
  return {
    base,
    stats: async (): Promise<Stats> => (await fetch(`${base}/_brust/cache/stats`)).json() as Promise<Stats>,
    stop: async () => {
      proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
    },
  }
}
```

- [ ] **Step 2: Write the e2e tests** (order matters: `/` warms the shared jobs first)

```ts
// tests/server/pokedex.test.ts — spec §10 integration assertions against the real CLI. Run alone:
// `bun test --timeout 120000 tests/server/pokedex.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, startPokedex } from './harness'

let srv: Awaited<ReturnType<typeof startPokedex>>
beforeAll(async () => { srv = await startPokedex() }, 120_000)
afterAll(async () => { try { await srv?.stop() } finally { rmSync(join(app, 'dist'), { recursive: true, force: true }) } })
const get = async (p: string) => { const r = await fetch(`${srv.base}${p}`); return { r, html: await r.text() } }
const scripts = (html: string) => [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!)

test('/: 200, document root, HeroSearch useId stable across two requests, all 18 TypeBadges painted, island SSR + chunk', async () => {
  const { r, html } = await get('/')
  expect(r.status).toBe(200)
  expect(html.startsWith('<!DOCTYPE html>') || html.startsWith('<html')).toBe(true)
  expect(html).toContain('<html lang="en" data-mode="dark">')
  expect(html).toContain('<title>PokéDex · built with brust</title>')
  expect(html).toContain('Every Pokémon')
  // useId (F39): label/input share the server id and it is identical on a second request.
  const id = /<label for="(brust-r1-[^"]+)"/.exec(html)![1]!
  expect(html).toContain(`<input id="${id}"`)
  expect((await get('/')).html).toContain(`<label for="${id}"`)
  // Per-row TypeBadge (one job per type, batched): 18 chips in ALL_TYPES order with the helper's colours.
  const chips = [...html.matchAll(/data-type="([a-z]+)" style="background:\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]])
  expect(chips.length).toBe(18)
  expect(chips[0]).toEqual(['normal', '#9099a1']); expect(chips[3]).toEqual(['electric', '#f5c84b'])
  // React child (S12): SSR HTML inside the host, its chunk linked, the runtime linked.
  expect(html).toMatch(/<brust-island data-id="teamBuilder_[0-9a-f]{8}" x-props='[^']*'>[\s\S]*My team[\s\S]*<\/brust-island>/)
  expect(html).toMatch(/data-testid="team-count">2</)
  const s = scripts(html)
  expect(s.some((u) => /\/_brust\/client\/runtime-[0-9a-f]{10}\.js$/.test(u))).toBe(true)
  expect(s.some((u) => /\/_brust\/client\/react-teamBuilder_[0-9a-f]{8}-[0-9a-f]{10}\.js$/.test(u))).toBe(true)
  const st = await srv.stats()
  expect(st.loader_calls).toBe(2); expect(st.job_calls).toBe(2)   // one batched jobs call per request (no route cache on /)
})

test('/pokedex: every DexCard row painted in dex order with per-row props; ?q= filters in the loader', async () => {
  const { r, html } = await get('/pokedex')
  expect(r.status).toBe(200)
  const nums = [...html.matchAll(/data-dex="(#\d{4})"/g)].map((m) => m[1])
  expect(nums.length).toBe(151); expect(nums[0]).toBe('#0001'); expect(nums[150]).toBe('#0151')
  expect(html.indexOf('Bulbasaur')).toBeLessThan(html.indexOf('Ivysaur'))
  expect(html).toContain('data-testid="count">151 / 151<')
  const q = await get('/pokedex?q=pika')
  expect([...q.html.matchAll(/data-dex="/g)].length).toBe(1)
  expect(q.html).toContain('Results for “pika”')
})

test('job cache HIT across two routes sharing a component and inputs; /pokemon/{name} is an L1 HIT on the second request', async () => {
  const before = await srv.stats()
  const { r: r1, html: h1 } = await get('/pokemon/pikachu')
  expect(r1.status).toBe(200)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  expect(h1).toContain('<title>Pikachu · PokéDex</title>')
  expect(h1).toContain('Mouse Pokémon')
  expect(h1).toContain('0.4 m'); expect(h1).toContain('6.0 kg')            // detailPage j0 (fmtHeight/fmtWeight)
  expect(h1).toMatch(/data-type="electric" style="background:\s*#f5c84b/)   // the same TypeBadge job `/` already ran
  const a1 = await srv.stats()
  expect(a1.loader_calls - before.loader_calls).toBe(1)
  expect(a1.job.hits - before.job.hits).toBeGreaterThanOrEqual(2)        // typeBadge{electric} + teamBuilder ssr
  expect(a1.job.misses - before.job.misses).toBe(1)                      // only detailPage j0 is new
  const { r: r2, html: h2 } = await get('/pokemon/pikachu')
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  expect(h2).toBe(h1)
  const a2 = await srv.stats()
  expect(a2.loader_calls).toBe(a1.loader_calls); expect(a2.job_calls).toBe(a1.job_calls)
  expect(a2.l1.hits - a1.l1.hits).toBe(1)
  // ?nocache=1 bypasses L1 (bench probe B): loader again, no job call (every job is cached).
  const { r: r3 } = await get('/pokemon/pikachu?nocache=1')
  expect(r3.headers.get('x-brust-cache')).not.toBe('HIT')
  const a3 = await srv.stats()
  expect(a3.loader_calls - a2.loader_calls).toBe(1); expect(a3.job_calls).toBe(a2.job_calls)
})

test('per-row child values painted per row: bulbasaur = grass then poison (F34 __typeBadge_k array)', async () => {
  const { html } = await get('/pokemon/bulbasaur')
  const chips = [...html.matchAll(/data-type="([a-z]+)" style="background:\s*(#[0-9a-f]{6})/g)].map((m) => `${m[1]}:${m[2]}`)
  expect(chips).toEqual(['grass:#63bb5b', 'poison:#ab6ac8'])
  expect(html).toContain('0.7 m')
})

test('/pokemon/nothing: loader notFound renders the route template at 404, never cached', async () => {
  const { r, html } = await get('/pokemon/nothing')
  expect(r.status).toBe(404)
  expect(html).toContain('No Pokémon named “Nothing”')
  expect(html).toContain('<title>Nothing · PokéDex</title>')
  const again = await get('/pokemon/nothing')
  expect(again.r.status).toBe(404); expect(again.r.headers.get('x-brust-cache')).toBe('MISS')
})

test('/type-chart: one loader call and no job call on the first request (every job cached), then an L1 HIT with no Bun call', async () => {
  const b = await srv.stats()
  const { r, html } = await get('/type-chart')
  expect(r.status).toBe(200)
  expect(html).toContain('<h1 class="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">Type chart</h1>')
  expect(html).toContain('Fire → Grass: 2× (super effective)')
  expect(scripts(html).some((u) => /typeChart_/.test(u))).toBe(false)      // static leaf: no chunk of its own
  const a = await srv.stats()
  expect(a.loader_calls - b.loader_calls).toBe(1); expect(a.job_calls).toBe(b.job_calls)
  const second = await get('/type-chart')
  expect(second.r.headers.get('x-brust-cache')).toBe('HIT')
  const c = await srv.stats()
  expect(c.loader_calls).toBe(a.loader_calls); expect(c.job_calls).toBe(a.job_calls)
})

test('catch-all is a static document: 404, 0 Bun calls on the first request, no script tag at all; public files served', async () => {
  const b = await srv.stats()
  const { r, html } = await get('/nope/really')
  expect(r.status).toBe(404)
  expect(html).toContain('<title>Not found · PokéDex</title>')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('brust-island')
  expect(await srv.stats()).toMatchObject({ loader_calls: b.loader_calls, job_calls: b.job_calls })
  const css = await fetch(`${srv.base}/public/app.css`)
  expect(css.status).toBe(200); expect(css.headers.get('content-type')).toContain('text/css')
})

test('cookie mode=light reaches the first paint', async () => {
  const r = await fetch(`${srv.base}/`, { headers: { cookie: 'mode=light' } })
  expect(await r.text()).toContain('<html lang="en" data-mode="light">')
})
```
Run: `bun test --timeout 120000 tests/server/pokedex.test.ts` — Expected: the first run FAILS only where the plan's guesses about exact markup differ from what the compiler emits (`<label for=…>` vs `htmlFor`, `style="background: …"` spacing, `<!DOCTYPE`): read the real HTML (`curl` the running demo), fix the TEST's literal, never the assertion's meaning. A failure on a counter (`job.hits`, `job_calls`, `loader_calls`) is a bug, not a literal: investigate before touching the number.

- [ ] **Step 3: Chromium hydration test** (the one Playwright test, F45)

```ts
// tests/server/hydrate.chromium.test.ts — real Chromium: the react child's server HTML hydrates without a React
// mismatch (console.error) and is interactive. Run alone: `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { app, startPokedex } from './harness'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
let srv: Awaited<ReturnType<typeof startPokedex>>
let browser: Browser
beforeAll(async () => { srv = await startPokedex(); browser = await chromium.launch() }, 180_000)
afterAll(async () => { await browser?.close(); try { await srv?.stop() } finally { rmSync(join(app, 'dist'), { recursive: true, force: true }) } })

test('/pokemon/pikachu hydrates the TeamBuilder island with no console error; "My team" toggles the panel; ThemeToggle flips data-mode', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))   // offline CI
  await page.goto(`${srv.base}/pokemon/pikachu`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('brust-island[data-hydrated="1"]', { timeout: 15_000 })
  expect(await page.locator('[data-testid="team-panel"]').count()).toBe(0)
  await page.getByRole('button', { name: /My team/ }).click()
  await page.locator('[data-testid="team-panel"]').waitFor({ state: 'visible' })
  expect(await page.locator('[data-testid="team-panel"] a').allTextContents()).toEqual(['Bulbasaur', 'Charmander'])
  await page.locator('[data-testid="team-panel"] button[aria-label="Remove"]').first().click()
  expect(await page.locator('[data-testid="team-count"]').textContent()).toBe('1')
  // Native hook on the same page (ThemeToggle: useState + useEffect).
  expect(await page.getAttribute('html', 'data-mode')).toBe('dark')
  await page.getByTestId('theme-toggle').click()
  expect(await page.getAttribute('html', 'data-mode')).toBe('light')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
```
Run: `bunx playwright install chromium && bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` — Expected: `1 pass`. Negative control (RUN it): temporarily make `TeamBuilder` render `{Date.now()}` in the button → the test must fail with a React hydration `console.error` in `errors`; revert.

- [ ] **Step 4: CI + root scripts**

Root `package.json` scripts: `"server-test": "bun test --timeout 120000 tests/server/pokedex.test.ts && bun test --timeout 120000 tests/server/hydrate.chromium.test.ts"` (two invocations: one server-starting file per process, the m2c rule).
`.github/workflows/ci.yml`, `server` job, append after the `e2e.test.ts` step:
```yaml
      # m2e: the pokedex dogfood (spec §10). Each server-starting file runs alone.
      - run: cd examples/pokedex && bun test
      - run: bunx playwright install --with-deps chromium
      - run: bun test --timeout 120000 tests/server/pokedex.test.ts
      - run: bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
```
Note the `server` job already builds the addon with `build:debug` (`ci.yml:107`); the e2e does not need release speed.

- [ ] **Step 5: Commit**

```bash
git add tests/server package.json .github/workflows/ci.yml
git commit -m "test(server): pokedex e2e (routes, 404, L1/job cache, per-row, useId, island) + Chromium hydration test"
```

---

### Task 4: Bench — `bench/run.ts`, `RESULTS.{md,json}`

**Files:**
- Create: `bench/run.ts`, `bench/README.md`, `bench/RESULTS.md`, `bench/RESULTS.json` (generated by a real run on the implementer's host; committed)
- Modify: `package.json` (root script `bench`), `.github/workflows/ci.yml` (`server` job: `bun build --no-bundle bench/run.ts > /dev/null`)

**Interfaces:**
- Consumes: `oha` 1.11 (`-c -z --no-tui --output-format json -m GET`, `--rand-regex-url`; 0.1.x `scripts/benchmark.ts:285-305`), v2 app (`examples/pokedex`, `brust build` + `brust start`), 0.1.x app (`$BRUST_01X_DIR/example/pokedex`, started with `cd $BRUST_01X_DIR && bun run example/pokedex/index.ts`, env `BRUST_PORT`, readiness `listening on 127.0.0.1:(\d+)` — `tests/integration.test.ts:1542-1551` on main), env knobs `BENCH_CONN` (120), `BENCH_DUR` (`10s`), `BENCH_WARMUP` (`3s`) as 0.1.x `:52-55`.
- Produces: `bench/RESULTS.json`:
  `{ date, host: "<platform>/<arch>", bun, conn, dur, warmup, addon: "release", bar: "met" | "not met" | "not measured", probes: [{ id: "A-static-hit"|"B-native-miss"|"C-react-child", path, v2: {rps,p50,p95,p99,total}, x01: {…} | null, deltaRpsPct: number | null }] }` and `bench/RESULTS.md` (table + conditions).

- [ ] **Step 1: The script**

```ts
// bench/run.ts — three probes on v2 examples/pokedex and on the 0.1.x example/pokedex (BRUST_01X_DIR). Manual.
//   bun run bench                                   # v2 only → bar: not measured
//   BRUST_01X_DIR=/Users/detoro/code/brust bun run bench
// Requires: oha on PATH; a RELEASE addon in packages/brust/native (cd packages/brust && bun run build); for the
// 0.1.x side: its release addon (cd $BRUST_01X_DIR/runtime && bun run build) and its pokedex built
// (bun run runtime/cli/index.ts build example/pokedex/index.ts). The 0.1.x loaders hit PokeAPI on the first
// request per name: the warm-up GETs every name once on BOTH apps before measuring (network needed for 0.1.x only).
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import snap from '../examples/pokedex/data/pokedex.json'

const ROOT = resolve(import.meta.dir, '..')
const CONN = Number.parseInt(process.env.BENCH_CONN ?? '120', 10)
const DUR = process.env.BENCH_DUR ?? '10s'
const WARMUP = process.env.BENCH_WARMUP ?? '3s'
const NAMES = snap.pokemon.map((p) => p.name)
type Nums = { rps: number; p50: number; p95: number; p99: number; total: number }
type Probe = { id: string; path: string; regex?: (base: string, nocache: boolean) => string }
const PROBES: Probe[] = [
  { id: 'A-static-hit', path: '/type-chart' },
  { id: 'B-native-miss', path: '/pokemon/{name}', regex: (base, nocache) => `${base}/pokemon/(${NAMES.join('|')})${nocache ? '\\?nocache=1' : ''}` },
  { id: 'C-react-child', path: '/' },
]

function need(cond: boolean, msg: string): void { if (!cond) { console.error(`[bench] ${msg}`); process.exit(1) } }
need(Bun.spawnSync(['oha', '--version']).exitCode === 0, 'oha not on PATH (cargo install oha)')
const native = join(ROOT, 'packages/brust/native')
need(existsSync(native) && readdirSync(native).some((f) => f.endsWith('.node')), 'no addon: cd packages/brust && bun run build (RELEASE)')
need(process.env.BRUST_RELEASE_ADDON === '1', 'set BRUST_RELEASE_ADDON=1 to assert you built with `bun run build`, not build:debug (the bench cannot tell)')

async function waitFor(proc: ReturnType<typeof Bun.spawn>, re: RegExp): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(); const dec = new TextDecoder(); let out = ''
  for (;;) { const { done, value } = await reader.read(); if (done) throw new Error(`exited:\n${out}`); out += dec.decode(value, { stream: true }); const m = re.exec(out); if (m) { void (async () => { for (;;) { const r = await reader.read(); if (r.done) return } })(); return m[1]! } }
}
async function startV2(): Promise<{ base: string; stop: () => void }> {
  const app = join(ROOT, 'examples/pokedex'); const bin = join(ROOT, 'packages/brust/bin/brust')
  need(Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app }).exitCode === 0, 'v2 build failed')
  const p = Bun.spawn([bin, 'start', '--port', '38201', '--workers', process.env.BRUST_WORKERS ?? '6'], { cwd: app, env: { ...process.env, BRUST_PORT: '' }, stdout: 'pipe', stderr: 'inherit' })
  await waitFor(p, /\[brust\] ready/)
  return { base: 'http://127.0.0.1:38201', stop: () => p.kill('SIGINT') }
}
async function start01x(dir: string): Promise<{ base: string; stop: () => void }> {
  need(readdirSync(join(dir, 'runtime')).some((f) => f.endsWith('.node')), `0.1.x addon missing in ${dir}/runtime (cd runtime && bun run build)`)
  const p = Bun.spawn(['bun', 'run', 'example/pokedex/index.ts'], { cwd: dir, env: { ...process.env, BRUST_PORT: '38202', BRUST_WORKERS: process.env.BRUST_WORKERS ?? '6', RUST_LOG: 'brust=warn' }, stdout: 'pipe', stderr: 'inherit' })
  const port = await waitFor(p, /listening on 127\.0\.0\.1:(\d+)/)
  return { base: `http://127.0.0.1:${port}`, stop: () => p.kill('SIGINT') }
}
async function warm(base: string): Promise<void> {        // every name once (0.1.x fetches PokeAPI here), then the fixed paths
  for (const n of NAMES) await fetch(`${base}/pokemon/${n}`)
  for (const p of ['/', '/type-chart']) for (let i = 0; i < 3; i++) await fetch(`${base}${p}`)
}
async function oha(args: string[]): Promise<Nums> {
  const p = Bun.spawn(['oha', '-c', String(CONN), '--no-tui', '--output-format', 'json', '-m', 'GET', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  need((await p.exited) === 0, `oha failed: ${err}`)
  const j = JSON.parse(out)
  return { rps: j.summary.requestsPerSec, p50: j.latencyPercentiles.p50 * 1000, p95: j.latencyPercentiles.p95 * 1000, p99: j.latencyPercentiles.p99 * 1000, total: j.summary.total }
}
async function measure(base: string, probe: Probe, nocache: boolean): Promise<Nums> {
  const target = probe.regex ? ['--rand-regex-url', probe.regex(base, nocache)] : [`${base}${probe.path}`]
  await oha(['-z', WARMUP, ...target])                        // discarded JIT warm-up (0.1.x rule)
  return oha(['-z', DUR, ...target])
}

const v2 = await startV2(); await warm(v2.base)
const dir01 = process.env.BRUST_01X_DIR
const x01 = dir01 ? await start01x(dir01) : null; if (x01) await warm(x01.base)
const probes = []
for (const pr of PROBES) {
  const a = await measure(v2.base, pr, true)
  const b = x01 ? await measure(x01.base, pr, false) : null
  probes.push({ id: pr.id, path: pr.path, v2: a, x01: b, deltaRpsPct: b ? Math.round(((a.rps - b.rps) / b.rps) * 1000) / 10 : null })
  console.log(`${pr.id.padEnd(16)} v2 ${a.rps.toFixed(0).padStart(7)} rps${b ? `   0.1.x ${b.rps.toFixed(0).padStart(7)} rps   Δ ${probes.at(-1)!.deltaRpsPct}%` : ''}`)
}
v2.stop(); x01?.stop()
const bar = !x01 ? 'not measured' : probes.every((p) => p.v2.rps >= p.x01!.rps) ? 'met' : 'not met'
const result = { date: new Date().toISOString().slice(0, 10), host: `${process.platform}/${process.arch}`, bun: Bun.version, conn: CONN, dur: DUR, warmup: WARMUP, addon: 'release', bar, probes }
writeFileSync(join(ROOT, 'bench/RESULTS.json'), `${JSON.stringify(result, null, 2)}\n`)
const f = (n: number) => n.toFixed(2)
const md = [`# M2 bench — ${result.date}`, '', `**Conditions:** \`oha -c ${CONN} -z ${DUR}\` · warm-up ${WARMUP} discarded · Bun ${Bun.version} · host ${result.host} · release addon · workers ${process.env.BRUST_WORKERS ?? '6'}`, '',
  '| Probe | Path | v2 rps | v2 p50 | v2 p99 | 0.1.x rps | 0.1.x p50 | 0.1.x p99 | Δ rps |', '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...probes.map((p) => `| ${p.id} | \`${p.path}\` | ${Math.round(p.v2.rps).toLocaleString()} | ${f(p.v2.p50)} | ${f(p.v2.p99)} | ${p.x01 ? Math.round(p.x01.rps).toLocaleString() : '—'} | ${p.x01 ? f(p.x01.p50) : '—'} | ${p.x01 ? f(p.x01.p99) : '—'} | ${p.deltaRpsPct === null ? '—' : `${p.deltaRpsPct}%`} |`),
  '', `**Bar (v2 not slower on any probe): ${bar}.** A = L1 HIT on v2 / full render on 0.1.x (no cache there); B = L1 bypassed on v2 (\`?nocache=1\`), loader every request, jobs from the job cache; C = page with the TeamBuilder react child on both.`, '', 'Generated by `bun run bench` — see `bench/run.ts`. macOS numbers are not Linux numbers.', '']
writeFileSync(join(ROOT, 'bench/RESULTS.md'), md.join('\n'))
console.log(`bar: ${bar} — wrote bench/RESULTS.{md,json}`)
```
Root `package.json`: `"bench": "bun bench/run.ts"`. `bench/README.md`: the four prerequisites from the header comment and the knobs.

- [ ] **Step 2: Syntax gate in CI** — `ci.yml` `server` job, append: `- run: bun build --no-bundle bench/run.ts > /dev/null`. Run locally: `bun build --no-bundle bench/run.ts > /dev/null && echo ok` — Expected: `ok`.

- [ ] **Step 3: Verify the oha JSON field names** before trusting `rps`/percentiles: `oha -c 2 -z 1s --no-tui --output-format json http://127.0.0.1:38201/type-chart | head -40` against a running demo; adjust the three `j.…` reads if oha 1.11 names them differently (`summary.requestsPerSec`, `latencyPercentiles.p50` are 0.1.x's reads at `scripts/benchmark.ts:320-340`; confirm).

- [ ] **Step 4: Run it for real** (the committed numbers)

```bash
cd packages/brust && bun run build                                   # RELEASE addon
cd $BRUST_01X_DIR && (cd runtime && bun run build) && bun run runtime/cli/index.ts build example/pokedex/index.ts
cd /path/to/lane && BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/Users/detoro/code/brust bun run bench
```
Expected: three lines with v2 and 0.1.x rps and a final `bar: met`. If `not met` on any probe: do NOT tune the test; file the numbers as they are, open a `task challenge` with the per-probe deltas (the exit criterion fails by design until the lead rules). Negative control: run with `BRUST_01X_DIR` unset once and confirm `bar: not measured` and `x01: null` in the JSON.

- [ ] **Step 5: Commit**

```bash
git add bench package.json .github/workflows/ci.yml
git commit -m "bench: three-probe oha comparison of v2 examples/pokedex vs 0.1.x pokedex (RESULTS.md/json, bar)"
```

---

### Task 5: Exit report generator `scripts/m2-exit/` + ledger owner column

**Files:**
- Create: `scripts/m2-exit/exit.ts`, `scripts/m2-exit/run.ts`, `scripts/m2-exit/exit.test.ts`, `docs/plans/m2-exit-report.md` (generated, committed)
- Modify: `docs/plans/m1a-followups.md` (owner column of F34 → `DONE — m2b server half; pinned end to end by m2e tests/server/pokedex.test.ts (per-row TypeBadge)`; F45 → `DONE — m2e tests/server/hydrate.chromium.test.ts (Playwright Chromium)`), `package.json` (root script `m2-exit`), `.github/workflows/ci.yml` (`server` job)

**Interfaces:**
- Consumes: `examples/pokedex/dist/manifest.json` from a fresh `brust build` (`ManifestJson`, `build/manifest.ts:53-59`), `bench/RESULTS.json` (T4 shape), the `| F<n> | … | <owner> |` rows of `docs/plans/m1a-followups.md`, `packages/runtime-dom/package.json` `private` (boundary-extension flag).
- Produces: `renderExitReport(i: ExitInputs): string` (pure); pinned sets `ROUTES`, `PROBES`, `LEDGER_RANGE`, `MUST_BE_CLOSED`, `MAY_BE_REFILED`; `scripts/m2-exit/run.ts` builds the app, gathers the inputs, writes the report. Format follows `scripts/battery/exit.ts` (counts and set-derived prose only; no timestamps — the bench date comes from `RESULTS.json`, which IS a committed input).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/m2-exit/exit.test.ts — M2 exit criteria (spec §10) checked by code.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EXIT_REPORT, gatherInputs } from './run.ts'
import { LEDGER_RANGE, MAY_BE_REFILED, MUST_BE_CLOSED, PROBES, ROUTES, renderExitReport } from './exit.ts'

const inputs = await gatherInputs()   // runs `brust build` on examples/pokedex (≈10 s)

test('the committed exit report equals a fresh render', () => {
  expect(readFileSync(EXIT_REPORT, 'utf8')).toBe(renderExitReport(inputs))
})
test('the manifest serves exactly the pinned routes, with the pinned tiers', () => {
  expect(inputs.manifest.routes.map((r) => r.pattern)).toEqual(ROUTES.map((r) => r.pattern))
  for (const r of ROUTES) {
    const m = inputs.manifest.routes.find((x) => x.pattern === r.pattern)!
    const leaf = inputs.manifest.components[m.chain[m.chain.length - 1]!]!
    expect([r.pattern, leaf.tier]).toEqual([r.pattern, r.leafTier])
  }
})
test('bench: every pinned probe is in RESULTS.json and the bar reads from the numbers, never from prose', () => {
  expect(inputs.bench.probes.map((p) => p.id)).toEqual(PROBES.map((p) => p.id))
  const measured = inputs.bench.probes.every((p) => p.x01 !== null)
  const met = measured && inputs.bench.probes.every((p) => p.v2.rps >= p.x01!.rps)
  expect(inputs.bench.bar).toBe(!measured ? 'not measured' : met ? 'met' : 'not met')
  expect(inputs.bench.bar).toBe('met')                      // the M2 exit criterion itself
})
test('ledger F32–F49: every row has a state; the closed set is pinned', () => {
  const ids = LEDGER_RANGE.map((n) => `F${n}`)
  expect(inputs.ledger.map((r) => r.id)).toEqual(ids)
  expect(inputs.ledger.filter((r) => r.state === 'closed').map((r) => r.id)).toEqual(MUST_BE_CLOSED)
  for (const r of inputs.ledger.filter((r) => r.state === 'open')) expect([r.id, r.owner.length > 0, MAY_BE_REFILED.includes(r.id) || !['F32','F33','F34','F35','F37','F39','F40','F41','F42','F49'].includes(r.id)]).toEqual([r.id, true, true])
})
```
Run: `bun test scripts/m2-exit` — Expected: FAIL (`Cannot find module './run.ts'`).

- [ ] **Step 2: `exit.ts` — pinned sets and the pure renderer**

```ts
// scripts/m2-exit/exit.ts — the M2 exit report (spec §10): pinned sets + computed prose, no hand-written claims.
export interface ManifestLike { routes: { id: string; pattern: string; chain: string[]; cache: unknown }[]; components: Record<string, { tier: string; jobs: { kind: string }[]; children: unknown[]; client: string | null; use_id_slots: number }> }
export interface BenchLike { date: string; host: string; bun: string; conn: number; dur: string; bar: string; probes: { id: string; path: string; v2: { rps: number; p99: number }; x01: { rps: number; p99: number } | null; deltaRpsPct: number | null }[] }
export interface LedgerRow { id: string; where: string; finding: string; owner: string; state: 'closed' | 'open' }
export interface ExitInputs { manifest: ManifestLike; bench: BenchLike; ledger: LedgerRow[]; runtimeDomPublishable: boolean }

export const ROUTES = [
  { pattern: '/', leafTier: 'native', why: 'HeroSearch (useState + useId); per-row TypeBadge jobs; TeamBuilder island from the layout' },
  { pattern: '/pokedex', leafTier: 'native', why: 'DexFilter (useState) over keyed DexCard rows; loader reads ?q=' },
  { pattern: '/pokemon/{name}', leafTier: 'native', why: 'own precompute job (fmtHeight/fmtWeight); per-row TypeBadge; notFound verdict; L1 60 s tag pokemon; bypass query(nocache)' },
  { pattern: '/type-chart', leafTier: 'static', why: 'nested .map() grid; L1 3600 s tag types' },
  { pattern: '*', leafTier: 'static', why: 'own <html> document outside the layout: 0 Bun calls, no scripts' },
] as const
export const PROBES = [{ id: 'A-static-hit' }, { id: 'B-native-miss' }, { id: 'C-react-child' }] as const
export const LEDGER_RANGE = Array.from({ length: 18 }, (_, i) => 32 + i)          // F32..F49
/** Rows whose owner column starts with DONE at the time this lane closes (the test fails if reality differs). */
export const MUST_BE_CLOSED = ['F32', 'F33', 'F34', 'F35', 'F37', 'F39', 'F40', 'F45', 'F49']
/** Rows spec §10 lists that may remain re-filed with a reason in the owner column. */
export const MAY_BE_REFILED = ['F41', 'F42']

/** The ledger table rows `| F<n> | where | finding | fix | owner |`; state = owner column starts with `DONE`. */
export function parseLedger(md: string, ids: number[]): LedgerRow[] {
  const out: LedgerRow[] = []
  for (const n of ids) {
    const line = md.split('\n').find((l) => l.startsWith(`| F${n} |`))
    if (!line) throw new Error(`ledger row F${n} missing`)
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    const [id, where, finding, , owner] = cells as [string, string, string, string, string]
    out.push({ id, where, finding, owner, state: owner.startsWith('DONE') ? 'closed' : 'open' })
  }
  return out
}

export function renderExitReport(i: ExitInputs): string {
  const L: string[] = []
  const comps = Object.entries(i.manifest.components)
  const n = (f: (c: ManifestLike['components'][string]) => boolean) => comps.filter(([, c]) => f(c)).length
  L.push('# M2 exit report', '', 'Generated by `bun scripts/m2-exit/run.ts`; do not edit. Criteria are spec §10; `bun test scripts/m2-exit` checks them by code.', '')
  L.push('## Dogfood (`examples/pokedex`)', '')
  L.push(`- ${i.manifest.routes.length} routes served by \`brust start\` from \`dist/manifest.json\`; ${comps.length} compiled components: ${n((c) => c.tier === 'static')} static, ${n((c) => c.tier === 'native')} native, ${n((c) => c.tier === 'react')} react; ${comps.reduce((a, [, c]) => a + c.jobs.length, 0)} job records (${comps.reduce((a, [, c]) => a + c.jobs.filter((j) => j.kind === 'ssr').length, 0)} ssr); ${comps.reduce((a, [, c]) => a + c.children.length, 0)} inlined child instance records; ${comps.reduce((a, [, c]) => a + c.use_id_slots, 0)} useId slot(s).`, '')
  L.push('| Route | Leaf tier | Chain | Cache | Exercises |', '|---|---|---|---|---|')
  for (const r of ROUTES) {
    const m = i.manifest.routes.find((x) => x.pattern === r.pattern)!
    L.push(`| \`${r.pattern}\` | ${i.manifest.components[m.chain[m.chain.length - 1]!]!.tier} | ${m.chain.join(' → ')} | ${m.cache ? JSON.stringify(m.cache) : '—'} | ${r.why} |`)
  }
  L.push('', '## Integration (`tests/server/pokedex.test.ts`, `hydrate.chromium.test.ts`)', '', 'Every route 200 with expected text; `notFound` → 404 never cached; L1 HIT with `loader_calls` unchanged; `?nocache=1` bypass; job-cache HIT across `/` → `/pokemon/pikachu` (`job.hits` ≥ 2, `job.misses` = 1); per-row child values in row order; `useId` identical across requests; the catch-all makes 0 Bun calls and ships no script; the react child hydrates in Chromium with no console error and is interactive.', '')
  L.push('## Bench (`bench/RESULTS.json`)', '', `Measured ${i.bench.date} on ${i.bench.host}, Bun ${i.bench.bun}, \`oha -c ${i.bench.conn} -z ${i.bench.dur}\`. **Bar (v2 not slower on any probe): ${i.bench.bar}.**`, '', '| Probe | Path | v2 rps | 0.1.x rps | Δ |', '|---|---|---:|---:|---:|')
  for (const p of i.bench.probes) L.push(`| ${p.id} | \`${p.path}\` | ${Math.round(p.v2.rps).toLocaleString()} | ${p.x01 ? Math.round(p.x01.rps).toLocaleString() : '—'} | ${p.deltaRpsPct === null ? 'not measured' : `${p.deltaRpsPct}%`} |`)
  L.push('', '## Ledger F32–F49', '', `${i.ledger.filter((r) => r.state === 'closed').length} closed, ${i.ledger.filter((r) => r.state === 'open').length} re-filed (owner column of \`docs/plans/m1a-followups.md\`).`, '', '| Id | State | Owner / reason |', '|---|---|---|')
  for (const r of i.ledger) L.push(`| ${r.id} | ${r.state} | ${r.owner} |`)
  L.push('', '## Publish', '', `\`release.yml\` builds six targets and dry-runs \`bun publish\` for \`@brust/core\`, ${i.runtimeDomPublishable ? '`@brust/runtime-dom`' : '(`@brust/runtime-dom` still private: dry run skipped)'} and six \`@brust/native-<plat>\` on \`workflow_dispatch\`; publishing stays tag-gated and human.`, '')
  return L.join('\n')
}
```

- [ ] **Step 3: `run.ts` — gather inputs, write the file**

```ts
// scripts/m2-exit/run.ts — `bun scripts/m2-exit/run.ts` regenerates docs/plans/m2-exit-report.md.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ExitInputs, LEDGER_RANGE, parseLedger, renderExitReport } from './exit.ts'
const ROOT = resolve(import.meta.dir, '../..')
export const EXIT_REPORT = join(ROOT, 'docs/plans/m2-exit-report.md')
export async function gatherInputs(): Promise<ExitInputs> {
  const app = join(ROOT, 'examples/pokedex')
  const b = Bun.spawnSync([join(ROOT, 'packages/brust/bin/brust'), 'build', 'routes.tsx', '--out-dir', 'dist-exit'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const manifest = JSON.parse(readFileSync(join(app, 'dist-exit/manifest.json'), 'utf8'))
  rmSync(join(app, 'dist-exit'), { recursive: true, force: true })
  return {
    manifest,
    bench: JSON.parse(readFileSync(join(ROOT, 'bench/RESULTS.json'), 'utf8')),
    ledger: parseLedger(readFileSync(join(ROOT, 'docs/plans/m1a-followups.md'), 'utf8'), LEDGER_RANGE),
    runtimeDomPublishable: JSON.parse(readFileSync(join(ROOT, 'packages/runtime-dom/package.json'), 'utf8')).private !== true,
  }
}
if (import.meta.main) { writeFileSync(EXIT_REPORT, renderExitReport(await gatherInputs())); console.log(`wrote ${EXIT_REPORT}`) }
```
Root `package.json`: `"m2-exit": "bun scripts/m2-exit/run.ts"`.

- [ ] **Step 4: Ledger edits, generate, test**

Edit the two owner cells (F34, F45) as listed under Files. Then: `bun run m2-exit && bun test scripts/m2-exit` — Expected: `wrote …/m2-exit-report.md`; `4 pass`. If the ledger test fails on `MUST_BE_CLOSED`, the file and the pinned set disagree: read the rows (F41/F42 may have been closed by `m2a-compiler` — check their owner cells), move the id between `MUST_BE_CLOSED` and `MAY_BE_REFILED` ONLY with the evidence quoted in the commit body. Negative control (RUN): change one `why` string in `ROUTES`, run `git diff --exit-code docs/plans/m2-exit-report.md` → must exit 1; regenerate.

- [ ] **Step 5: CI** — `ci.yml` `server` job, append:
```yaml
      # The exit report is generated: a diff means the committed one is stale.
      - run: bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md
      - run: bun test scripts/m2-exit
```

- [ ] **Step 6: Commit**

```bash
git add scripts/m2-exit docs/plans/m2-exit-report.md docs/plans/m1a-followups.md package.json .github/workflows/ci.yml
git commit -m "docs(m2): generated exit report (routes, probes, ledger F32–F49) with CI diff and criteria test"
```

---

### Task 6: Release — `release.yml` (6 targets, dry run), `npm/<plat>` ×6, `release-bump.ts`

**Files:**
- Create: `.github/workflows/release.yml`, `npm/{darwin-x64,darwin-arm64,linux-x64-gnu,linux-arm64-gnu,linux-x64-musl,linux-arm64-musl}/package.json` (generated by `napi create-npm-dirs`, committed), `scripts/release-bump.ts`
- Modify: `packages/brust/package.json` (remove `private`; add `files`, `publishConfig`, `optionalDependencies`, script `build:target`), `packages/runtime-dom/package.json` (boundary extension: remove `private`, add `files`, `publishConfig`), `package.json` (root `workspaces` already has `npm/*` from T1), `bun.lock`

**Interfaces:**
- Consumes: `packages/brust/package.json` `napi` block (`binaryName: brust`, `packageName: @brust/native`, 6 targets — m2c D5); `@napi-rs/cli` 3 commands `create-npm-dirs`, `build --target --cross-compile`, `artifacts`, `prepublish`; 0.1.x `release.yml:44-73` (matrix) and `:133-225` (publish job); 0.1.x `scripts/release-bump.ts` (regex `setKey` + JSON verify pattern).
- Produces: `npm/<plat>/package.json` ×6 named `@brust/native-<plat>` with `main: brust.<plat>.node`, `os`/`cpu`, `version` 0.0.0; `packages/brust/package.json` `optionalDependencies: { "@brust/native-darwin-x64": "workspace:*", … ×6 }`, `dependencies: { "@brust/runtime-dom": "workspace:*" }`, `files: ["src", "bin", "native/index.js", "native/index.d.ts", "README.md"]`, `publishConfig: { access: "public" }`, script `"build:target": "napi build --platform --release --js index.js --dts index.d.ts --manifest-path ../../crates/brust-napi/Cargo.toml --output-dir native"` (CI appends `--target X [--cross-compile]`); `scripts/release-bump.ts <version> [--release]` bumping the 8 `version` fields (`packages/brust`, `packages/runtime-dom`, `npm/*` ×6) and verifying them + that every `@brust/*` dependency in `packages/brust` is `workspace:*`.

- [ ] **Step 1: Platform dirs + package manifests**

```bash
cd packages/brust && bunx napi create-npm-dirs --package-json-path package.json --npm-dir ../../npm
```
Expected: six dirs under `npm/`, each `package.json` `{ "name": "@brust/native-<plat>", "version": "0.0.0", "os": [...], "cpu": [...], "main": "brust.<plat>.node", "files": ["brust.<plat>.node"] }`. Add `"license": "MIT"`, `"repository"`, `"publishConfig": {"access":"public"}` by re-running with the fields present in `packages/brust/package.json` (napi copies `license`/`repository`/`description`), not by hand. Edit `packages/brust/package.json` and `packages/runtime-dom/package.json` as listed under Produces. Run `bun install` → `bun.lock` links the six `workspace:*` optional deps (no registry access: verify with `bun install --frozen-lockfile --offline` → exit 0).

- [ ] **Step 2: `release-bump.ts`** (port; 8 refs; `v2` branch)

```ts
#!/usr/bin/env bun
// scripts/release-bump.ts — bump EVERY @brust/* version atomically, then VERIFY (0.1.x lesson: 0.1.54/0.1.57 shipped
// partial bumps). Refs: packages/brust, packages/runtime-dom, npm/<6>. Dependencies between them are `workspace:*`
// (rewritten by `bun publish`), so there is nothing else to pin — the verify step enforces that invariant.
//   bun scripts/release-bump.ts 0.2.0-alpha.1            # bump + verify
//   bun scripts/release-bump.ts 0.2.0-alpha.1 --release  # + commit, tag v<version>, push (on v2 only)
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { $ } from 'bun'
const NEW = process.argv[2]; const RELEASE = process.argv.includes('--release')
if (!NEW || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(NEW)) { console.error('usage: bun scripts/release-bump.ts <version> [--release]'); process.exit(1) }
const ROOT = resolve(import.meta.dir, '..')
const PLATS = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl']
const FILES = ['packages/brust/package.json', 'packages/runtime-dom/package.json', ...PLATS.map((p) => `npm/${p}/package.json`)]
const EXPECTED = FILES.length // 8
function setVersion(text: string, v: string): { text: string; old: string | null } {
  const re = /("version"\s*:\s*")([^"]*)(")/; const m = text.match(re)
  return m ? { text: text.replace(re, `$1${v}$3`), old: m[2]! } : { text, old: null }
}
const changes: string[] = []
for (const f of FILES) {
  const abs = resolve(ROOT, f); const r = setVersion(readFileSync(abs, 'utf8'), NEW)
  if (r.old === null) { console.error(`✗ ${f}: no "version" — aborting, nothing written`); process.exit(1) }
  writeFileSync(abs, r.text); if (r.old !== NEW) changes.push(`  ${f}: ${r.old} → ${NEW}`)
}
let verified = 0; const problems: string[] = []
for (const f of FILES) { const j = JSON.parse(readFileSync(resolve(ROOT, f), 'utf8')); if (j.version === NEW) verified++; else problems.push(`  ${f}: ${j.version}`) }
const brust = JSON.parse(readFileSync(resolve(ROOT, 'packages/brust/package.json'), 'utf8'))
for (const [k, v] of Object.entries({ ...brust.dependencies, ...brust.optionalDependencies }) as [string, string][])
  if (k.startsWith('@brust/') && v !== 'workspace:*') problems.push(`  packages/brust ${k} is "${v}", must be workspace:* (bun publish rewrites it)`)
if (brust.private || JSON.parse(readFileSync(resolve(ROOT, 'packages/runtime-dom/package.json'), 'utf8')).private) problems.push('  a package is still "private": true')
if (problems.length || verified !== EXPECTED) { console.error(`✗ verification FAILED (${verified}/${EXPECTED})`); for (const p of problems) console.error(p); process.exit(1) }
console.log(`✓ bumped ${verified}/${EXPECTED} refs to ${NEW}`); for (const c of changes) console.log(c)
if (!RELEASE) { console.log(`\nnext: git commit -am "chore(release): ${NEW}" && git tag -a v${NEW} -m "brust ${NEW}" && git push origin HEAD v${NEW}`); process.exit(0) }
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()
if (branch !== 'v2') { console.error(`✗ --release refuses to run off v2 (on "${branch}")`); process.exit(1) }
await $`git add ${FILES}`; await $`git commit -m ${`chore(release): ${NEW}`}`; await $`git tag -a ${`v${NEW}`} -m ${`brust ${NEW}`}`
await $`git push origin HEAD`; await $`git push origin ${`v${NEW}`}`
console.log(`✓ pushed v${NEW} — release.yml publishes (human-confirmed by the tag)`)
```
Run: `bun scripts/release-bump.ts 0.0.1-test && git diff --stat` → `8 files changed`; then `git checkout -- packages npm` to revert. Negative control (RUN): set `packages/brust` `"@brust/runtime-dom": "0.0.0"` → the script must exit 1 naming it; revert.

- [ ] **Step 3: `release.yml`**

```yaml
name: release
# Builds the @brust/native addon for 6 targets (zig for every Linux cross leg: aws-lc-sys needs a per-target C
# compiler — 0.1.x release.yml:53-61) and, on workflow_dispatch, DRY-RUNS the npm publish of @brust/core,
# @brust/runtime-dom and the six @brust/native-<plat>. The real publish job is gated to `v*` tags: a human pushes
# the tag (scripts/release-bump.ts --release). Secret for the real publish: BRUST_NPM_TOKEN (memory npm-org-brust).
on:
  push: { tags: ["v*"] }
  workflow_dispatch:
permissions: { contents: read }
env: { CARGO_TERM_COLOR: always }
jobs:
  build:
    name: build ${{ matrix.target }}
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: macos-latest,  target: aarch64-apple-darwin,       napi_extra: "" }
          - { runner: macos-latest,  target: x86_64-apple-darwin,        napi_extra: "" }
          - { runner: ubuntu-latest, target: x86_64-unknown-linux-gnu,   napi_extra: "" }
          - { runner: ubuntu-latest, target: aarch64-unknown-linux-gnu,  napi_extra: "--cross-compile", setup_zig: true }
          - { runner: ubuntu-latest, target: x86_64-unknown-linux-musl,  napi_extra: "--cross-compile", setup_zig: true }
          - { runner: ubuntu-latest, target: aarch64-unknown-linux-musl, napi_extra: "--cross-compile", setup_zig: true }
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: nightly-2026-09-15, components: "rust-src", targets: "${{ matrix.target }}" }
      - uses: Swatinem/rust-cache@v2
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.4.2" }
      - run: bun install --frozen-lockfile
      - name: Setup zig (cross legs; plain tarball, no node20 action — 0.1.x release.yml:95-106)
        if: matrix.setup_zig
        run: |
          curl -fsSL https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz | tar -xJ
          echo "$PWD/zig-linux-x86_64-0.13.0" >> "$GITHUB_PATH"
      - name: Install cargo-zigbuild (cross legs)
        if: matrix.setup_zig
        run: cargo install --locked cargo-zigbuild
      - name: napi build (release)
        run: cd packages/brust && bun run build:target --target ${{ matrix.target }} ${{ matrix.napi_extra }}
      - uses: actions/upload-artifact@v4
        with: { name: "bindings-${{ matrix.target }}", path: packages/brust/native/brust.*.node, if-no-files-found: error }
  dry-run:
    name: npm publish --dry-run
    needs: build
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: nightly-2026-09-15, components: "rust-src" }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.4.2" }
      - run: bun install --frozen-lockfile
      - name: Generate the loader (index.js + index.d.ts) on the host
        run: cd packages/brust && bun run build:debug
      - uses: actions/download-artifact@v4
        with: { pattern: "bindings-*", path: packages/brust/native, merge-multiple: true }
      - name: Assemble npm/<plat> (six .node files into the committed dirs)
        run: cd packages/brust && bunx napi artifacts --package-json-path package.json --output-dir native --npm-dir ../../npm
      - name: Dry-run publish (bun rewrites workspace:* to the version)
        run: |
          set -e
          for d in packages/runtime-dom packages/brust npm/*; do (cd "$d" && bun publish --dry-run --access public); done
          cd packages/brust && bun pm pack --destination /tmp/pack && tar -xOf /tmp/pack/*.tgz package/package.json > /tmp/packed.json
          ! grep -q 'workspace:' /tmp/packed.json || { echo 'packed @brust/core still contains workspace: deps'; exit 1; }
          grep -c '"@brust/native-' /tmp/packed.json | grep -qx 6
  publish:
    name: publish to npm (tag only — a human action)
    needs: build
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: nightly-2026-09-15, components: "rust-src" }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.4.2" }
      - run: bun install --frozen-lockfile
      - run: cd packages/brust && bun run build:debug
      - uses: actions/download-artifact@v4
        with: { pattern: "bindings-*", path: packages/brust/native, merge-multiple: true }
      - run: cd packages/brust && bunx napi artifacts --package-json-path package.json --output-dir native --npm-dir ../../npm
      - name: Publish (runtime-dom → brust → six natives; prerelease also moves `latest`, 0.1.x policy)
        run: |
          set -e
          VERSION=$(bun -e "console.log(require('./packages/brust/package.json').version)")
          if [[ "$VERSION" == *-* ]]; then TAG=alpha; else TAG=latest; fi
          for d in packages/runtime-dom packages/brust npm/*; do (cd "$d" && bun publish --access public --tag "$TAG"); done
          if [[ "$VERSION" == *-* ]]; then for p in @brust/runtime-dom @brust/core $(ls npm | sed 's/^/@brust\/native-/'); do npm dist-tag add "$p@$VERSION" latest; done; fi
        env: { NPM_CONFIG_TOKEN: "${{ secrets.BRUST_NPM_TOKEN }}", NODE_AUTH_TOKEN: "${{ secrets.BRUST_NPM_TOKEN }}" }
```
Note the order: `@brust/core` depends on `@brust/runtime-dom`, so runtime-dom publishes first (0.1.x published the main name first to secure it; `brust` the org already exists, memory `npm-org-brust`).

- [ ] **Step 4: Local dry run of the dry-run steps**

```bash
cd packages/brust && bun run build:debug && bunx napi artifacts --package-json-path package.json --output-dir native --npm-dir ../../npm
for d in packages/runtime-dom packages/brust npm/darwin-arm64; do (cd "$d" && bun publish --dry-run --access public); done
cd packages/brust && bun pm pack --destination /tmp/pack && tar -xOf /tmp/pack/*.tgz package/package.json | grep -c workspace:
```
Expected: `napi artifacts` copies the host `.node` into `npm/darwin-arm64/`; three dry runs print the tarball listing and `Dry run: …` without error; the last command prints `0`. If `bun publish --dry-run` keeps `workspace:*` (it must not), STOP and challenge: the fallback is literal pins + 8 more bump refs, a lead ruling.

- [ ] **Step 5: Validate the workflow** — push the lane branch, `gh workflow run release.yml --ref lane/m2e-pokedex-exit` (the workflow is `workflow_dispatch` on any ref), `gh run watch` → CONCLUSION `success` on all 6 `build` legs and `dry-run` (memory `release-mirror-ci-gates`: watch the conclusion, not exit 0). Paste the run URL in the task note.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml npm scripts/release-bump.ts packages/brust/package.json packages/runtime-dom/package.json bun.lock
git commit -m "release: six-target addon matrix with zig cross legs, npm publish dry run on dispatch, release-bump over 8 @brust/* refs"
```

---

## Verification (READY evidence, paste in the task note)

```
cd packages/brust && bun run build:debug                                          # addon for the e2e
cd examples/pokedex && bun test                                                    # 3 pass (snapshot ×2, build ×1)
bun test --timeout 120000 tests/server/pokedex.test.ts                             # 8 pass
bunx playwright install chromium && bun test --timeout 120000 tests/server/hydrate.chromium.test.ts   # 1 pass
bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md && bun test scripts/m2-exit     # 4 pass, no diff
bun build --no-bundle bench/run.ts > /dev/null                                    # syntax
cat bench/RESULTS.md                                                               # three probes, bar: met, host + Bun version
bun scripts/release-bump.ts 0.0.1-test && git checkout -- packages npm             # ✓ bumped 8/8
gh run list --workflow=release.yml --limit 1                                       # dispatch run: success (URL)
```
PR `lane/m2e-pokedex-exit` → `v2`, CI green on all jobs (the `server` job now runs the pokedex suites, the Chromium test, the exit diff), lane HEAD sha. The exit demo by hand: `cd examples/pokedex && bun run build && bun run start`, then `/`, `/pokedex`, `/pokemon/pikachu`, `/type-chart`, `/pokemon/nothing` (404) in a browser.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2e-pokedex-exit` | 1–6 | standard | Implementer (Standard) | `m2c-napi-package`, `m2x-minijinja-3` merged | complex | Verification block pasted with counts; `bench/RESULTS.md` with `bar: met` (or a challenge with the deltas); `release.yml` dispatch run URL with success on 6 legs + dry-run; PR → `v2` CI green; lane HEAD sha |
