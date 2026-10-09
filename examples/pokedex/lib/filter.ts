import type { DexCard } from './types'
export function filterSort(items: DexCard[], q: string, az: boolean): DexCard[] {
  const needle = q.trim().toLowerCase()
  const out = needle ? items.filter((c) => c.name.includes(needle)) : items.slice()
  return az ? out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : out
}
