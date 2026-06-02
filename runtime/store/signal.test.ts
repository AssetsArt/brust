import { expect, test } from 'bun:test'
import { batch, computed, effect, isComputed, isSignal, signal } from './signal.ts'

test('signal read returns initial; .set(v) updates; .set(fn) updates from prev', () => {
  const s = signal(1)
  expect(s()).toBe(1)
  s.set(2)
  expect(s()).toBe(2)
  s.set((p) => p + 10)
  expect(s()).toBe(12)
})

test('Object.is guard: .set to equal value does NOT notify', () => {
  const s = signal(1)
  let runs = 0
  effect(() => {
    s()
    runs++
  })
  expect(runs).toBe(1)
  s.set(1)
  expect(runs).toBe(1)
  s.set(2)
  expect(runs).toBe(2)
})

test('computed memoizes for repeated reads with no dep change; recomputes after dep .set', () => {
  const s = signal(2)
  let calls = 0
  const c = computed(() => {
    calls++
    return s() * 10
  })
  expect(c()).toBe(20)
  expect(c()).toBe(20)
  expect(calls).toBe(1)
  s.set(3)
  expect(c()).toBe(30)
  expect(calls).toBe(2)
})

test('effect runs once immediately, re-runs on tracked dep change, stops after dispose', () => {
  const s = signal(0)
  let runs = 0
  const dispose = effect(() => {
    s()
    runs++
  })
  expect(runs).toBe(1)
  s.set(1)
  expect(runs).toBe(2)
  dispose()
  s.set(2)
  expect(runs).toBe(2)
})

test('batch: two .set inside one batch → effect re-runs once', () => {
  const a = signal(0)
  const b = signal(0)
  let runs = 0
  effect(() => {
    a()
    b()
    runs++
  })
  expect(runs).toBe(1)
  batch(() => {
    a.set(1)
    b.set(1)
  })
  expect(runs).toBe(2)
})

test('effect that reads and conditionally writes the same signal does not stack-overflow', () => {
  const a = signal(0)
  let runs = 0
  // Without the re-entrancy guard, the write inside the effect re-triggers the
  // same consumer mid-run → unbounded recursion → stack overflow. The guard
  // drops the re-entrant re-run, so this runs once, bumps a once, and settles.
  effect(() => {
    runs++
    if (a() < 3) a.set(a() + 1)
  })
  expect(runs).toBe(1)
  expect(a()).toBe(1)
  // A later external write re-runs the effect cleanly (guard already reset).
  a.set(0)
  expect(a()).toBe(1)
  expect(runs).toBe(2)
})

test('brands: isSignal / isComputed', () => {
  expect(isSignal(signal(1))).toBe(true)
  expect(isSignal(computed(() => 1))).toBe(false)
  expect(isComputed(computed(() => 1))).toBe(true)
  expect(isComputed(signal(1))).toBe(false)
})

// Cross-chunk safety: each island is a separate Bun.build that inlines its own
// copy of signal.ts. The brand MUST live in the GLOBAL Symbol registry
// (Symbol.for), not a per-module Symbol(), or isSignal() from one chunk fails to
// recognize a signal created in another — which poisons the shared store snapshot
// (regression: team dock read empty after a SPA nav loaded a new island chunk).
test('brands use the global Symbol registry (Symbol.for) so they are cross-chunk-stable', () => {
  const s = signal(1) as unknown as Record<symbol, unknown>
  const c = computed(() => 1) as unknown as Record<symbol, unknown>
  expect(s[Symbol.for('brust.signal')]).toBe(true)
  expect(c[Symbol.for('brust.computed')]).toBe(true)
})
