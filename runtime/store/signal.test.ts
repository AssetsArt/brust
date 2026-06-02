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

test('brands: isSignal / isComputed', () => {
  expect(isSignal(signal(1))).toBe(true)
  expect(isSignal(computed(() => 1))).toBe(false)
  expect(isComputed(computed(() => 1))).toBe(true)
  expect(isComputed(signal(1))).toBe(false)
})
