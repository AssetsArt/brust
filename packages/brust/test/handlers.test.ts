import { describe, expect, test } from 'bun:test'
import * as handlers from '../src/handlers'
import * as worker from '../src/worker'

describe('handlers.ts is the pure half of worker.ts', () => {
  test('worker re-exports the same bindings', () => {
    for (const k of ['makeHandlers', 'literalsIndex', 'jobIdOf', 'routeStoresIndex', 'toJson'] as const)
      expect(worker[k]).toBe(handlers[k])
  })

  test('bundles for a worker host with no Bun/napi/worker_threads', async () => {
    const r = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/handlers.ts`], target: 'browser', external: ['node:*'] })
    expect(r.success).toBe(true)
    const text = await r.outputs[0]!.text()
    for (const needle of ['worker_threads', 'registerWorker', 'planJobs', 'Buffer']) expect(text).not.toContain(needle)
  })

  test('jsonCall never rejects', async () => {
    const ok = handlers.jsonCall(async (q: { n: number }) => ({ n: q.n + 1 }))
    expect(await ok('{"n":1}')).toBe('{"n":2}')
    expect(JSON.parse(await ok('not json')).error).toBeString()
    const boom = handlers.jsonCall(async () => {
      throw new Error('boom')
    })
    expect(JSON.parse(await boom('{}')).error).toContain('boom')
  })
})

test('@brust/core/server-handlers exposes what the generated entry imports', async () => {
  const m = await import('@brust/core/server-handlers')
  for (const k of ['makeHandlers', 'jsonCall', 'flattenRoutes', 'fetchInScope', 'noActions'] as const) expect(m[k]).toBeFunction()
  expect((await import('@brust/core/server-handlers/actions')).mountActions).toBeFunction()
})
