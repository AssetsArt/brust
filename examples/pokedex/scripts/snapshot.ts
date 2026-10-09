// examples/pokedex/scripts/snapshot.ts — run ONCE with network: `bun run snapshot`. Writes data/pokedex.json.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const API = 'https://pokeapi.co/api/v2'
const ALL_TYPES = ['normal','fire','water','electric','grass','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy']
const idFromUrl = (url: string) => Number(/\/(\d+)\/?$/.exec(url)![1])
const clean = (s: string) => s.replace(/[\n\f\r]+/g, ' ').trim()
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`)
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return (await r.json()) as T
}
// biome-ignore lint/suspicious/noExplicitAny: PokeAPI JSON
type J = any
async function chain(url: string): Promise<{ id: number; name: string; minLevel: number | null }[]> {
  const data = await (await fetch(url)).json() as J
  const out: { id: number; name: string; minLevel: number | null }[] = []
  let node = data.chain
  while (node) {                                   // linear walk, first branch (0.1.x rule)
    out.push({ id: idFromUrl(node.species.url), name: node.species.name, minLevel: node.evolution_details?.[0]?.min_level ?? null })
    node = node.evolves_to?.[0]
  }
  return out
}
const pokemon = []
for (let id = 1; id <= 151; id++) {
  const p = await get<J>(`/pokemon/${id}`)
  const s = await get<J>(`/pokemon-species/${id}`)
  pokemon.push({
    id, name: p.name,
    types: p.types.map((t: J) => t.type.name),
    stats: p.stats.map((st: J) => ({ name: st.stat.name, base: st.base_stat })),
    artwork: p.sprites?.other?.['official-artwork']?.front_default ?? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`,
    genus: s.genera.find((g: J) => g.language.name === 'en')?.genus ?? '',
    flavorText: clean(s.flavor_text_entries.find((e: J) => e.language.name === 'en')?.flavor_text ?? ''),
    height: p.height, weight: p.weight,
    abilities: p.abilities.map((a: J) => a.ability.name),
    evolution: await chain(s.evolution_chain.url),
  })
  process.stderr.write(`\r${id}/151`)
}
const types: Record<string, Record<string, number>> = {}
for (const t of ALL_TYPES) {
  const d = await get<J>(`/type/${t}`)
  const rel: Record<string, number> = {}
  for (const x of d.damage_relations.double_damage_to) rel[x.name] = 2
  for (const x of d.damage_relations.half_damage_to) rel[x.name] = 0.5
  for (const x of d.damage_relations.no_damage_to) rel[x.name] = 0
  types[t] = rel
}
writeFileSync(join(import.meta.dir, '../data/pokedex.json'), `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), pokemon, types }, null, 1)}\n`)
console.log('\nwrote data/pokedex.json')
