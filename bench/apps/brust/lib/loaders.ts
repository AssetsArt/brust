import type { LoaderCtx } from '@brust/core/routes'
import { type Badge, type DexRow, loadDex, TYPE_BADGES } from './data'

/** Chrome every leaf returns: Layout reads `title` from the merged loader context (child keys win). */
export async function typesLoader(_ctx: LoaderCtx): Promise<{ title: string; badges: Badge[] }> {
  return { title: 'Types · bench', badges: TYPE_BADGES }
}
export async function dexLoader(_ctx: LoaderCtx): Promise<{ title: string; rows: DexRow[]; summary: string }> {
  const rows = loadDex()
  // `summary` is one text slot: `{count} Pokémon` (a prop + literal) compiles to <p><span x-text>151</span> Pokémon</p>.
  return { title: 'Pokédex · bench', rows, summary: `${rows.length} Pokémon` }
}
export async function teamLoader(_ctx: LoaderCtx): Promise<{ title: string; start: number; label: string }> {
  return { title: 'Team · bench', start: 0, label: 'clicks' }
}
