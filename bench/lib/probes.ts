// bench/lib/probes.ts — the three pages every app serves (spec §1.2). `?nocache=1` is honoured by brust only.
export type ProbeId = 'S' | 'D' | 'I'
export interface Probe { id: ProbeId; path: string; what: string }
export const PROBES: readonly Probe[] = [
  { id: 'S', path: '/types', what: 'cacheable: 18 type tiles (brust L1 HIT, Next static)' },
  { id: 'D', path: '/dex?nocache=1', what: 'dynamic SSR: loader reads data.json, 151 rows, TypeBadge per row' },
  { id: 'I', path: '/team?nocache=1', what: 'one interactive Counter island (useReducer), SSR + hydration tags' },
]
export const probe = (id: ProbeId): Probe => PROBES.find((p) => p.id === id) ?? (() => { throw new Error(`unknown probe ${id}`) })()
