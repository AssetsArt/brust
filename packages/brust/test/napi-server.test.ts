import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { beginDrain, cacheInvalidate, cacheStats, localAddr, registerWorker, startServer, untilReady } from '../native/index.js'

// Task 4 moves this into `src/worker.ts` (`writeSlot`); inline until then.
function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  let bytes = new TextEncoder().encode(json)
  if (bytes.byteLength > sub) bytes = new TextEncoder().encode(JSON.stringify({ error: `response too large: ${bytes.byteLength} > ${sub}` }))
  view.set(bytes, slot * sub)
  return bytes.byteLength
}

const dist = resolve(import.meta.dir, '../../../crates/brust-server/tests/fixtures/dist')

type JobCall = { id: string; componentId: string; target?: string; inputs: any }
// The FakeBun default jobs (crates/brust-server/tests/common/mod.rs `default_job`).
function jobValue(call: JobCall) {
  const job = call.id.split('/').at(call.id.startsWith(`${call.componentId}/`) ? 1 : 2)
  if (call.componentId === 'detailPage_c3' && job === 'j0') return { _s1: 'HP 35' }
  if (call.componentId === 'moveCard_d4' && job === 'j0') return { _s1: `MOVE ${call.inputs.move.name}` }
  if ((call.target ?? call.componentId) === 'teamBuilder_h8') return '<ul><li>a</li></ul>'
  throw new Error(`unexpected job ${call.id}`)
}

const SLOTS = 2
const sab = new Uint8Array(new SharedArrayBuffer(256 * 1024 * SLOTS))
const kinds: string[] = []
const handler = async (kind: string, requestJson: string, slot: number) => {
  kinds.push(kind)
  const req = JSON.parse(requestJson)
  return writeSlot(
    sab,
    slot,
    SLOTS,
    JSON.stringify(
      kind === 'loader'
        ? { ok: true, data: { pokemon: { name: req.params.name ?? null, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon' } }
        : { results: req.jobs.map((j: JobCall) => ({ id: j.id, value: jobValue(j) })) },
    ),
  )
}

test('startServer + one worker answers pages, HIT skips Bun, invalidate forces MISS', async () => {
  expect(() => cacheStats()).toThrow(/startServer has not been called/)
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 500, generator: 'brust/test' })
  await expect(untilReady(50)).rejects.toThrow(/workers failed to register within 50 ms/)
  expect(registerWorker(sab, SLOTS, handler)).toBeGreaterThanOrEqual(0)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

  const home = await fetch(`${base}/`)
  expect(home.status).toBe(200)
  expect(home.headers.get('x-powered-by')).toBe('brust/test')
  expect(await home.text()).toContain('<main><h1>Home</h1></main>')
  expect(JSON.parse(cacheStats()).loader_calls).toBe(0)

  const r1 = await fetch(`${base}/pokemon/pikachu`)
  expect(r1.status).toBe(200)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  const body = await r1.text()
  expect(body).toContain('<p>HP 35</p>')
  expect(body).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  expect(kinds).toEqual(['loader', 'jobs']) // one batched jobs call per page

  const r2 = await fetch(`${base}/pokemon/pikachu`)
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  await r2.text()
  expect(JSON.parse(cacheStats()).loader_calls).toBe(1)

  // react-tier child: ssr job on the parent with `target` (D6).
  const team = await fetch(`${base}/team`)
  expect(team.status).toBe(200)
  expect(await team.text()).toContain('<ul><li>a</li></ul>')

  expect(cacheInvalidate({ tags: ['pokemon'] })).toEqual({ l1Removed: 1, jobRemoved: 0 })
  const r3 = await fetch(`${base}/pokemon/pikachu`)
  expect(r3.headers.get('x-brust-cache')).toBe('MISS')
  await r3.text()
  expect(cacheInvalidate({ path: '/pokemon/pikachu' })).toEqual({ l1Removed: 1, jobRemoved: 0 })

  await beginDrain(1000)
  expect(() => startServer({ host: '127.0.0.1', port: 0, distDir: '/nonexistent', workers: 0 })).toThrow(/manifest: .*manifest\.json/)
  // A failed start keeps the previous server as the current one.
  expect(JSON.parse(cacheStats()).loader_calls).toBe(3) // pikachu MISS ×2 + /team
})
