import { describe, expect, test } from 'bun:test'
import { batch, computed, effect, signal, untracked } from '../src/signal'

describe('signal', () => {
  test('read/write and functional update', () => {
    const n = signal(1)
    expect(n()).toBe(1)
    n.set(2); expect(n()).toBe(2)
    n.set((p) => p + 1); expect(n()).toBe(3)
  })
  test('Object.is dedupe: same value does not notify', () => {
    const n = signal(1); let runs = 0
    effect(() => { n(); runs++ })
    n.set(1); expect(runs).toBe(1)
    n.set(2); expect(runs).toBe(2)
  })
  test('computed is lazy and cached', () => {
    const a = signal(2); let evals = 0
    const d = computed(() => { evals++; return a() * 2 })
    expect(evals).toBe(0)
    expect(d()).toBe(4); expect(d()).toBe(4); expect(evals).toBe(1)
    a.set(3); expect(evals).toBe(1); expect(d()).toBe(6); expect(evals).toBe(2)
  })
  test('effect runs now, re-runs on change, cleanup before re-run and on dispose', () => {
    const a = signal(0); const log: string[] = []
    const dispose = effect(() => { log.push(`run ${a()}`); return () => log.push(`clean ${a.peek()}`) })
    a.set(1)
    dispose()
    expect(log).toEqual(['run 0', 'clean 1', 'run 1', 'clean 1'])
    a.set(2); expect(log.length).toBe(4)
  })
  test('batch defers effects to the end', () => {
    const a = signal(0), b = signal(0); let runs = 0
    effect(() => { a(); b(); runs++ })
    batch(() => { a.set(1); b.set(1) })
    expect(runs).toBe(2)
  })
  test('untracked read does not subscribe', () => {
    const a = signal(0), b = signal(0); let runs = 0
    effect(() => { a(); untracked(() => b()); runs++ })
    b.set(1); expect(runs).toBe(1)
    a.set(1); expect(runs).toBe(2)
  })
  test('computed chain only recomputes once per batch', () => {
    const a = signal(1); let evals = 0
    const b = computed(() => a() + 1); const c = computed(() => { evals++; return b() + 1 })
    effect(() => { c() })
    batch(() => { a.set(2); a.set(3) })
    expect(c()).toBe(5); expect(evals).toBe(2)
  })
})
