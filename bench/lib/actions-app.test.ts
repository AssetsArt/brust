import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import data from '../apps/_shared/data.json'
import { actionsApp, servedCount } from '../apps/_shared/actions-app'

test('the shared actions app: GET /types, POST /team, 422 on a bad body, counter counts the two good calls', async () => {
  const app = new Elysia({ prefix: '/_brust/action' }).use(actionsApp())
  const before = servedCount()
  const g = await app.fetch(new Request('http://x/_brust/action/types'))
  expect(g.status).toBe(200)
  const types = (await g.json()) as unknown[]
  expect(types).toHaveLength(18)
  expect(types).toEqual(data.types)
  const post = (body: string) => app.fetch(new Request('http://x/_brust/action/team', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
  const ok = await post('{"id":25}')
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ ok: true, id: 25 })
  const bad = await post('{"id":"x"}')
  expect(bad.status).toBe(422)
  expect(servedCount() - before).toBe(2)
})

test('elysia-bun: one process answers A1 and A2 through the Bun adapter; handlers run JS (counter moves)', async () => {
  const { startApp } = await import('./app')
  const run = await startApp({
    id: 'brust', port: 0, cwd: import.meta.dir, ready: /\[elysia-bun\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    startCmd: () => ({ cmd: ['bun', join(import.meta.dir, '../apps/elysia-bun/index.ts')], env: { BENCH_PORT: '0', BENCH_CTRL_PORT: '0', NODE_ENV: 'production' } }),
  })
  try {
    const g = await fetch(`${run.base}/_brust/action/types`)
    expect(g.status).toBe(200)
    expect(await g.json()).toEqual(data.types)
    const p = await fetch(`${run.base}/_brust/action/team`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":25}' })
    expect(p.status).toBe(200)
    expect(await p.json()).toEqual({ ok: true, id: 25 })
  } finally {
    await run.stop()
  }
  expect(await Bun.spawnSync(['sh', '-c', `kill -0 ${run.proc.pid}`]).exitCode).not.toBe(0)
}, 30_000)
