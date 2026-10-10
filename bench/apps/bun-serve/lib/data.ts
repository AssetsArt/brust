import data from '../../_shared/data.json'
export type TypeRow = (typeof data.types)[number]
export type DexRow = (typeof data.pokemon)[number]
export const TYPES: TypeRow[] = data.types
export const TINT: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.tint]))
export const LABEL: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.label]))
/** Re-read per request (D is "loader reads data.json"): a fresh array, like a loader would return. */
export const loadDex = (): DexRow[] => data.pokemon.map((p) => ({ ...p }))
