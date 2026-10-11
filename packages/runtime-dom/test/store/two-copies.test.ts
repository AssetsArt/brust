import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import * as A from '../../src/signal'

// A byte-copy loaded from a temp dir is a distinct module instance (verified on Bun canary).
async function secondCopy(): Promise<typeof A> {
  const dir = mkdtempSync(join(tmpdir(), 'brust-signal-copy-'))
  const file = join(dir, 'signal.ts')
  copyFileSync(join(import.meta.dir, '../../src/signal.ts'), file)
  return (await import(file)) as typeof A
}

test('brands and tracking hold across two module instances', async () => {
  const B = await secondCopy()
  expect(B.signal).not.toBe(A.signal)

  // brands
  expect(A.isSignal(B.signal(1))).toBe(true)
  expect(B.isSignal(A.signal(1))).toBe(true)
  expect(A.isComputed(B.computed(() => 1))).toBe(true)
  expect(B.isSignal(A.computed(() => 1))).toBe(false)

  // tracking: an effect from copy A subscribes to a signal from copy B
  const s = B.signal(0)
  let runs = 0
  A.effect(() => {
    s()
    runs++
  })
  expect(runs).toBe(1)
  s.set(1)
  expect(runs).toBe(2)

  // batching crosses copies too: a computed from A read by an effect from B
  const c = A.computed(() => s() * 2)
  const seen: number[] = []
  B.effect(() => {
    seen.push(c())
  })
  A.batch(() => {
    s.set(2)
    s.set(3)
  })
  expect(seen).toEqual([2, 6])
  expect(runs).toBe(3)

  // ctx lives on the global
  const ctx = (globalThis as Record<symbol, Record<string, unknown> | undefined>)[Symbol.for('brust.reactive.ctx')]
  expect(ctx).toBeDefined()
  expect(Object.keys(ctx as object).sort()).toEqual(['batchDepth', 'currentSub', 'pending'])
})
