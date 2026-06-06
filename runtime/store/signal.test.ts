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

test('effect cleanup: returned fn runs before each re-run and once on dispose', () => {
  const s = signal(0)
  const log: string[] = []
  const dispose = effect(() => {
    const v = s()
    log.push(`run:${v}`)
    return () => log.push(`cleanup:${v}`)
  })
  expect(log).toEqual(['run:0'])
  // re-run: previous run's cleanup fires FIRST (React useEffect re-run order).
  s.set(1)
  expect(log).toEqual(['run:0', 'cleanup:0', 'run:1'])
  // dispose: the current run's cleanup fires once.
  dispose()
  expect(log).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1'])
  // disposed → no further runs or cleanups.
  s.set(2)
  expect(log).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1'])
})

test('effect cleanup runs UNTRACKED — reading a signal inside cleanup adds no dependency', () => {
  const dep = signal(0)
  const other = signal(0)
  let runs = 0
  const dispose = effect(() => {
    dep()
    runs++
    return () => {
      other() // reading here must NOT subscribe the effect to `other`
    }
  })
  expect(runs).toBe(1)
  dep.set(1) // re-run → previous cleanup reads `other`
  expect(runs).toBe(2)
  other.set(1) // had cleanup subscribed, this would re-run the effect → it must NOT
  expect(runs).toBe(2)
  dispose()
})

test('disposing an effect whose cleanup writes a depended-on signal does NOT re-run the body', () => {
  const s = signal(0)
  let runs = 0
  const dispose = effect(() => {
    s() // subscribe
    runs++
    return () => {
      s.set(99) // cleanup mutates a dep — must not resurrect the disposed effect
    }
  })
  expect(runs).toBe(1)
  dispose()
  expect(runs).toBe(1) // disposed → the write in cleanup must not re-run the body
})

test('dispose() called twice runs cleanup exactly once and does not throw', () => {
  const log: string[] = []
  const dispose = effect(() => {
    return () => log.push('cleanup')
  })
  dispose()
  expect(() => dispose()).not.toThrow()
  expect(log).toEqual(['cleanup'])
})

test('effect with no returned cleanup (void) still works and disposes cleanly', () => {
  const s = signal(0)
  let runs = 0
  const dispose = effect(() => {
    s()
    runs++
  })
  expect(runs).toBe(1)
  s.set(1)
  expect(runs).toBe(2)
  expect(() => dispose()).not.toThrow()
  s.set(2)
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
