// The loader's data source (D: "loader reads data.json"). Imported once per worker; rows copied per call.
// Badges (label + tint) are precomputed here: a job-bearing child inside the nested `rows.map(types.map)` is the
// v2 build error `nested-instance` (M3), so TypeBadge is a plain static child fed by the loader.
import data from '../../_shared/data.json'
export interface Badge { type: string; label: string; color: string }
export interface DexRow { id: number; name: string; displayName: string; num: string; badges: Badge[] }
const badge = new Map<string, Badge>(data.types.map((t) => [t.name, { type: t.name, label: t.label, color: t.tint }]))
const toBadge = (type: string): Badge => badge.get(type) ?? { type, label: type, color: '#888888' }
export const TYPE_BADGES: Badge[] = data.types.map((t) => toBadge(t.name))
export const loadDex = (): DexRow[] => data.pokemon.map((p) => ({ id: p.id, name: p.name, displayName: p.displayName, num: p.num, badges: p.types.map(toBadge) }))
