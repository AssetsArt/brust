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

// F585 (AMENDMENT 2): a bigint in a reply is its decimal digits, not a failed reply; the normal path is a plain stringify.
describe('toJson and a bigint', () => {
  test('top level, in an array, nested in an object; 0n', () => {
    expect(handlers.toJson({ results: [{ id: 'a', value: { _s1: 10n, _s2: [1n, -2n], _s3: { n: { m: 0n } } } }] })).toBe(
      '{"results":[{"id":"a","value":{"_s1":"10","_s2":["1","-2"],"_s3":{"n":{"m":"0"}}}}]}',
    )
    expect(handlers.toJson(0n)).toBe('"0"')
  })

  test('a reply without a bigint is exactly JSON.stringify', () => {
    const v = { a: 1, b: [null, 'x'], c: { d: true }, e: NaN, f: undefined }
    expect(handlers.toJson(v)).toBe(JSON.stringify(v))
  })

  test('a reply with a bigint AND another failure still reports that other failure', () => {
    const loop: Record<string, unknown> = { n: 1n }
    loop.self = loop
    const err = JSON.parse(handlers.toJson(loop)).error as string
    expect(err).toContain('response not serialisable')
    expect(err).toMatch(/cyclic|circular/i)
    const throws = { n: 1n, toJSON: () => { throw new Error('mine') } }
    expect(JSON.parse(handlers.toJson({ a: 2n, b: throws })).error).toContain('mine')
  })
})
