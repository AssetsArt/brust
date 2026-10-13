// website/test/demos.test.ts — the rules the browser-only demos run (plan R5-R7), without a browser: the team's
// add rule (cap, duplicate, unknown id), the stored-value parser, the cache simulation against the route's real
// cache config, and the Loaders lookup.
import { expect, test } from 'bun:test'
import { createCacheSim, DEMO_TTL_SECONDS } from '../components/demos/cache-sim'
import { lookup } from '../components/demos/loader-lookup'
import { addTo, MAX_TEAM, member, teamFromValue } from '../components/demos/team-client'
import { routes } from '../routes'

test('team: six fit, a duplicate is unchanged, the seventh is TeamFull 409, an unknown id is UnknownPokemon 404', () => {
  let team = [25, 1, 4, 7, 133, 143].map(member)
  expect(team.length).toBe(MAX_TEAM)
  expect(addTo(team, 25)).toEqual({ ok: true, team })
  expect(addTo(team, 150)).toEqual({ ok: false, status: 409, title: 'TeamFull', detail: 'the team already has 6 members' })
  team = team.slice(0, 2)
  expect(addTo(team, 9999)).toEqual({ ok: false, status: 404, title: 'UnknownPokemon', detail: 'no Pokémon #9999 in this demo' })
  const r = addTo(team, 150)
  expect(r.ok && r.team.map((m) => m.id)).toEqual([25, 1, 150])
})

test('team: the stored value drops unknown and repeated ids and keeps at most six', () => {
  expect(teamFromValue(null)).toEqual([])
  expect(teamFromValue('25.25.9999.x.1').map((m) => m.id)).toEqual([25, 1])
  expect(teamFromValue('1.4.7.25.133.143.150').length).toBe(MAX_TEAM)
})

test('cache simulation: the rules of the real demo route', () => {
  const demo = (routes[0] as { children: { path?: string; cache?: unknown }[] }).children.find((r) => r.path === '/demo/pokemon/{name}')
  expect(demo?.cache).toEqual({ ttl_seconds: DEMO_TTL_SECONDS, tags: ['pokemon'], bypass: 'query(nocache)' })
  let now = 0
  const sim = createCacheSim(() => now)
  expect(sim.get('/demo/pokemon/eevee?v=1')).toEqual({ status: 200, cache: 'MISS' })
  expect(sim.get('/demo/pokemon/eevee?v=1')).toEqual({ status: 200, cache: 'HIT' })
  expect(sim.get('/demo/pokemon/eevee?v=1', 'HEAD')).toEqual({ status: 200, cache: 'HIT' })
  expect(sim.get('/demo/pokemon/eevee?v=1&nocache=1')).toEqual({ status: 200, cache: 'BYPASS' })
  expect(sim.get('/demo/pokemon/eevee?a=1&a=2')).toEqual({ status: 200, cache: 'BYPASS' })
  expect(sim.get('/demo/pokemon/eevee?b=2&a=1').cache).toBe('MISS')
  expect(sim.get('/demo/pokemon/eevee?a=1&b=2').cache).toBe('HIT')
  // a 404 is never stored
  expect(sim.get('/demo/pokemon/agumon')).toEqual({ status: 404, cache: 'MISS' })
  expect(sim.get('/demo/pokemon/agumon')).toEqual({ status: 404, cache: 'MISS' })
  now = DEMO_TTL_SECONDS * 1000
  expect(sim.get('/demo/pokemon/eevee?v=1').cache).toBe('MISS')
})

test('loader lookup: trim, lower-case, 30 characters, lib/pokemon.ts', () => {
  expect(lookup(null).card.name).toBe('Pikachu')
  expect(lookup('  SnorLax ')).toMatchObject({ query: 'snorlax', found: true, card: { no: '#143', name: 'Snorlax' } })
  expect(lookup('agumon')).toMatchObject({ found: false, card: { no: '#???', name: 'agumon', types: [] } })
  expect(lookup('x'.repeat(40)).query.length).toBe(30)
})
