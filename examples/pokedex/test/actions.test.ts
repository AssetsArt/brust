// examples/pokedex/test/actions.test.ts — the team actions app (M3-F E7), driven without a server.
import { expect, test } from 'bun:test'
import { brust, LISTEN_ERROR } from '@brust/core/elysia'
import { client } from '@brust/core/client'
import { Elysia } from 'elysia'
import { type App, teamApp } from '../actions'
import { openTeamDb } from '../lib/team-db'

function setup() {
  const db = openTeamDb(':memory:')
  const calls: unknown[] = []
  const app = teamApp({ db: () => db, invalidate: (a) => { calls.push(a) } })
  const m = new Elysia({ adapter: brust(), prefix: '/_brust/action' }).use(app)
  const call = (p: string, init?: RequestInit) => Promise.resolve(m.fetch(new Request(`http://l/_brust/action${p}`, init)))
  const post = (body: unknown) => call('/team', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { db, calls, m, call, post }
}

test('GET /team → 200 { team: [], max: 6 }', async () => {
  const { call } = setup()
  const r = await call('/team')
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ team: [], max: 6 })
})

test('POST /team {id:25} → 200 with the member from the snapshot; invalidates the team tag', async () => {
  const { post, calls } = setup()
  const r = await post({ id: 25 })
  expect(r.status).toBe(200)
  const j = (await r.json()) as { team: Record<string, unknown>[]; max: number }
  expect(j.max).toBe(6)
  expect(j.team[0]).toMatchObject({ id: 25, name: 'pikachu', displayName: 'Pikachu', num: '#0025', types: ['electric'] })
  expect(calls).toEqual([{ tags: ['team'] }])
})

test('POST twice is idempotent (one row; a no-op does not invalidate)', async () => {
  const { post, calls, db } = setup()
  await post({ id: 25 })
  const r = await post({ id: 25 })
  expect(r.status).toBe(200)
  expect(db.list()).toHaveLength(1)
  expect(calls).toHaveLength(1)
})

test('the seventh distinct POST → 409 problem+json TeamFull; re-POST of a member when full → 200', async () => {
  const { post, calls } = setup()
  for (const id of [1, 4, 7, 25, 39, 94]) expect((await post({ id })).status).toBe(200)
  const r = await post({ id: 143 })
  expect(r.status).toBe(409)
  expect(r.headers.get('content-type')).toContain('application/problem+json')
  expect(await r.json()).toMatchObject({ title: 'TeamFull', status: 409, max: 6 })
  expect((await post({ id: 25 })).status).toBe(200)
  expect(calls).toHaveLength(6)
})

test('DELETE /team/25 → 200 without pikachu (invalidates); DELETE of an absent id → 200 unchanged (no invalidate)', async () => {
  const { post, call, calls } = setup()
  await post({ id: 25 })
  await post({ id: 4 })
  const r = await call('/team/25', { method: 'DELETE' })
  expect(r.status).toBe(200)
  expect(((await r.json()) as { team: { id: number }[] }).team.map((x) => x.id)).toEqual([4])
  expect(calls).toHaveLength(3)
  const r2 = await call('/team/25', { method: 'DELETE' })
  expect(r2.status).toBe(200)
  expect(((await r2.json()) as { team: { id: number }[] }).team.map((x) => x.id)).toEqual([4])
  expect(calls).toHaveLength(3)
})

test('POST { id: "x" } → 422 problem+json; POST { id: 999 } → 404 UnknownPokemon', async () => {
  const { post } = setup()
  const bad = await post({ id: 'x' })
  expect(bad.status).toBe(422)
  expect(bad.headers.get('content-type')).toContain('application/problem+json')
  const unknown = await post({ id: 999 })
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toMatchObject({ title: 'UnknownPokemon' })
})

test('typed client round trip', async () => {
  const { m } = setup()
  const api = client<App>({ baseUrl: 'http://l', fetch: ((i: RequestInfo | URL, init?: RequestInit) => Promise.resolve(m.fetch(new Request(i, init)))) as typeof fetch })
  const r = await api.team.post({ id: 4 })
  expect(r.data?.max).toBe(6)
  for (const id of [1, 7, 25, 39, 94]) await api.team.post({ id })
  const full = await api.team.post({ id: 143 })
  expect(full.error?.status).toBe(409)
  if (full.error?.status === 409) expect(full.error.value.max).toBe(6)
  const del = await api.team({ id: 4 }).delete()
  expect(del.data?.team.map((x) => x.id)).not.toContain(4)
  // @ts-expect-error id is required by the body schema
  void api.team.post({})
})

test('the default export is built on brust() and refuses listen()', async () => {
  const mod = await import('../actions')
  expect((mod.default as any)['~config'].adapter.name).toBe('brust')
  expect(() => (mod.default as any).listen(0)).toThrow(LISTEN_ERROR)
})
