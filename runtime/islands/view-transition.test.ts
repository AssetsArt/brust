import { describe, expect, test } from 'bun:test'
import { viewTransitionsEnabled, withViewTransition } from './view-transition.ts'

const MARKER = 'data-brust-view-transitions'

function stubDoc(opts: {
  supported: boolean
  marked: boolean
  throwSync?: boolean
  rejectAfter?: boolean
}): { doc: Document; cbCalls: () => number } {
  let calls = 0
  const doc = {
    documentElement: {
      hasAttribute: (n: string) => opts.marked && n === MARKER,
    },
  } as unknown as Document & { startViewTransition?: unknown }
  if (opts.supported) {
    // Faithful to the real API: startViewTransition returns the transition
    // object FIRST and invokes the callback ASYNCHRONOUSLY (after the browser
    // captures the old state), settling updateCallbackDone only once it runs.
    // This makes the tests actually prove withViewTransition AWAITS
    // updateCallbackDone — a stub that called the callback synchronously would
    // pass even an implementation that never awaited.
    ;(doc as { startViewTransition: unknown }).startViewTransition = (cb: () => void) => {
      if (opts.throwSync) throw new Error('sync throw before callback')
      const updateCallbackDone = new Promise<void>((resolve, reject) => {
        Promise.resolve().then(() => {
          try {
            cb()
            calls++
            if (opts.rejectAfter) reject(new Error('callback rejected'))
            else resolve()
          } catch (e) {
            reject(e as Error)
          }
        })
      })
      return { updateCallbackDone }
    }
  }
  return { doc, cbCalls: () => calls }
}

describe('viewTransitionsEnabled', () => {
  for (const supported of [true, false]) {
    for (const marked of [true, false]) {
      test(`supported=${supported} marked=${marked}`, () => {
        const { doc } = stubDoc({ supported, marked })
        expect(viewTransitionsEnabled(doc)).toBe(supported && marked)
      })
    }
  }
})

describe('withViewTransition — commit runs exactly once', () => {
  test('unsupported → direct commit, once, before resolve', async () => {
    const { doc } = stubDoc({ supported: false, marked: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })
  test('supported+marked → commit once, via the transition', async () => {
    const { doc } = stubDoc({ supported: true, marked: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })
  test('supported but NOT marked → direct commit, once', async () => {
    const { doc } = stubDoc({ supported: true, marked: false })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })
  test('startViewTransition throws SYNC (before callback) → commit still once (B2)', async () => {
    const { doc } = stubDoc({ supported: true, marked: true, throwSync: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })
  test('updateCallbackDone rejects AFTER commit ran → commit once, no re-run (B2)', async () => {
    const { doc } = stubDoc({ supported: true, marked: true, rejectAfter: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })
})
