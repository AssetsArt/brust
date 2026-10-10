import data from '../../_shared/data.json'
export type DexRow = (typeof data.pokemon)[number]
export const TYPE_NAMES: string[] = data.types.map((t) => t.name)
export const TINT: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.tint]))
export const LABEL: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.label]))
export const loadDex = (): DexRow[] => data.pokemon.map((p) => ({ ...p }))
