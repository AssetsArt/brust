import type { LoaderCtx } from '@brust/core/routes'
import { type Badge, type DexRow, loadDex, TYPE_BADGES } from './data'

/** Chrome every leaf returns: Layout reads `title` from the merged loader context (child keys win). */
export async function typesLoader(_ctx: LoaderCtx): Promise<{ title: string; badges: Badge[] }> {
  return { title: 'Types · bench', badges: TYPE_BADGES }
}
export async function dexLoader(_ctx: LoaderCtx): Promise<{ title: string; rows: DexRow[]; count: number }> {
  const rows = loadDex()
  return { title: 'Pokédex · bench', rows, count: rows.length }
}
export async function teamLoader(_ctx: LoaderCtx): Promise<{ title: string; start: number; label: string }> {
  return { title: 'Team · bench', start: 0, label: 'clicks' }
}
