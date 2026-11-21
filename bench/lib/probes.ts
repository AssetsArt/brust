// bench/lib/probes.ts — the pages every page app serves (spec §1.2) plus the two Elysia action probes (A1/A2).
// `?nocache=1` is honoured by brust only. `apps` = who serves the probe: the runner builds (app, probe) pairs from it.
import type { AppId } from './app'

export type ProbeId = 'S' | 'S-render' | 'D' | 'I' | 'A1' | 'A2'
export interface Probe {
  id: ProbeId
  kind: 'page' | 'json'
  path: string
  method: 'GET' | 'POST'
  body?: string
  apps: AppId[]
  what: string
}
const PAGE_APPS: AppId[] = ['brust', 'bun-serve', 'next', 'brust-01x']
const ACTION_APPS: AppId[] = ['brust', 'elysia-bun']
export const PROBES: readonly Probe[] = [
  { id: 'S', kind: 'page', method: 'GET', path: '/types', apps: PAGE_APPS, what: 'cacheable: 18 type tiles (brust L1 HIT, Next static)' },
  // F595 AMENDMENT 1: the S page rendered per request on the two apps that can be asked to (Next serves its prerender
  // whatever the query), so S compares caches and S-render compares rendering.
  { id: 'S-render', kind: 'page', method: 'GET', path: '/types?nocache=1', apps: ['brust', 'bun-serve'], what: 'the S page rendered per request (brust bypasses L1 on ?nocache=1; bun-serve always renders)' },
  { id: 'D', kind: 'page', method: 'GET', path: '/dex?nocache=1', apps: PAGE_APPS, what: 'dynamic SSR: loader reads data.json, 151 rows, TypeBadge per row' },
  { id: 'I', kind: 'page', method: 'GET', path: '/team?nocache=1', apps: PAGE_APPS, what: 'one interactive Counter island (useReducer), SSR + hydration tags' },
  { id: 'A1', kind: 'json', method: 'GET', path: '/_brust/action/types', apps: ACTION_APPS, what: 'Elysia GET: 18 types as JSON (no cache on either side)' },
  { id: 'A2', kind: 'json', method: 'POST', path: '/_brust/action/team', body: '{"id":25}', apps: ACTION_APPS, what: 'Elysia POST: TypeBox-validated {id} → {ok,id}' },
]
export const probe = (id: ProbeId): Probe => PROBES.find((p) => p.id === id) ?? (() => { throw new Error(`unknown probe ${id}`) })()
export const serves = (app: AppId, id: ProbeId): boolean => probe(id).apps.includes(app)
