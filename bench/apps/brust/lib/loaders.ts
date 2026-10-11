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
/** `?start=<n>` (attribution probe M only, v2-only): the island's start prop — a distinct job key per value, so
 * every M request misses the job cache. Absent (probe I and every other app) → 0, the parity page. */
export async function teamLoader(ctx: LoaderCtx): Promise<{ title: string; start: number; label: string }> {
  const s = Number.parseInt(ctx.req.search.start ?? '', 10)
  return { title: 'Team · bench', start: Number.isFinite(s) ? s : 0, label: 'clicks' }
}
