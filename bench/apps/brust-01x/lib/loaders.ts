import data from '../data.json'
export const TYPES = data.types as { name: string; label: string; tint: string }[]
const badge = (t: string) => TYPES.find((x) => x.name === t) ?? { name: t, label: t, tint: '#888888' }
export async function typesLoader() {
  return { title: 'Types · bench', teamProps: { start: 0, label: 'clicks' }, types: TYPES }
}
export async function dexLoader() {
  const rows = data.pokemon.map((p) => ({ id: p.id, num: p.num, displayName: p.displayName, badges: p.types.map(badge) }))
  return { title: 'Pokédex · bench', teamProps: { start: 0, label: 'clicks' }, rows, count: rows.length }
}
export async function teamLoader() {
  return { title: 'Team · bench', teamProps: { start: 0, label: 'clicks' } }
}
