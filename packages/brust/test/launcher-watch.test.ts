// F488: the launcher watch (process.ppid), with an injected platform / liveness (no Windows needed).
import { describe, expect, test } from 'bun:test'
import { processIdentity, watchLauncher } from '../src/launcher-watch'

describe('watchLauncher', () => {
  test('POSIX: watches nothing and never polls', () => {
    let polled = false
    const w = watchLauncher({ platform: 'linux', ppid: 4, onGone: () => {}, alive: () => ((polled = true), true) })
    expect(w.pid).toBeUndefined()
    expect(polled).toBe(false)
  })
  test('win32: onGone fires once, with the parent pid, after it disappears', async () => {
    let up = true
    const gone: number[] = []
    const done = new Promise<void>((r) => {
      watchLauncher({ platform: 'win32', ppid: 5, alive: () => up, intervalMs: 5, onGone: (p) => (gone.push(p), r()) })
    })
    await Bun.sleep(30)
    expect(gone).toEqual([]) // alive: nothing fires
    up = false
    await done
    await Bun.sleep(30)
    expect(gone).toEqual([5])
  })
  test('win32: a parent already gone at boot is not watched, and one line says so', () => {
    const lines: string[] = []
    const w = watchLauncher({ platform: 'win32', ppid: 5, alive: () => false, onGone: () => lines.push('FIRED'), log: (l) => lines.push(l) })
    expect(w.pid).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('already gone')
  })
  // F492 W1: the old test made `alive` answer true until the watch fired, so a stop() that left the timer running passed it too.
  // Now the parent dies right after stop(): a live timer would notice and fire onGone, and every liveness call is counted.
  test('win32: the watched pid is the parent; stop() clears the timer: no liveness call and no onGone after it', async () => {
    let up = true
    let calls = 0
    let fired = 0
    const w = watchLauncher({ platform: 'win32', ppid: 7, alive: () => (calls++, up), identity: () => 'a', intervalMs: 5, onGone: () => fired++ })
    expect(w.pid).toBe(7)
    await Bun.sleep(30)
    expect(calls).toBeGreaterThan(1) // it does poll while running (the check below is not vacuous)
    w.stop()
    const at = calls
    up = false // the launcher dies; a timer that was not cleared would see it
    await Bun.sleep(40)
    expect(calls).toBe(at)
    expect(fired).toBe(0)
  })
  test('win32: the timer is unref\'d, so a watch never keeps the process alive', () => {
    const set = globalThis.setInterval
    let ref: { hasRef(): boolean } | undefined
    globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => (ref = set(...a))) as typeof setInterval
    try {
      const w = watchLauncher({ platform: 'win32', ppid: 7, alive: () => true, identity: () => 'a', intervalMs: 5, onGone: () => {} })
      expect(ref?.hasRef()).toBe(false)
      w.stop()
    } finally {
      globalThis.setInterval = set
    }
  })
  // F492 W2: a PID that is reused by another process answers `kill(pid, 0)`; only its identity tells it is not the launcher.
  test('win32: a parent pid reused by another process (same pid, alive, other identity) counts as gone', async () => {
    let id = 'launcher'
    const gone: number[] = []
    const done = new Promise<void>((r) => {
      watchLauncher({ platform: 'win32', ppid: 9, alive: () => true, identity: () => id, intervalMs: 5, onGone: (p) => (gone.push(p), r()) })
    })
    await Bun.sleep(30)
    expect(gone).toEqual([]) // the same identity: nothing fires
    id = 'someone else'
    await done
    expect(gone).toEqual([9])
  })
  test('win32: an identity that cannot be read keeps the pid-only watch', async () => {
    let up = true
    const gone: number[] = []
    const done = new Promise<void>((r) => {
      watchLauncher({ platform: 'win32', ppid: 9, alive: () => up, identity: () => undefined, intervalMs: 5, onGone: (p) => (gone.push(p), r()) })
    })
    await Bun.sleep(30)
    expect(gone).toEqual([])
    up = false
    await done
    expect(gone).toEqual([9])
  })
  test('POSIX: no identity is read', () => {
    let read = false
    watchLauncher({ platform: 'linux', ppid: 4, onGone: () => {}, identity: () => ((read = true), 'x') })
    expect(read).toBe(false)
    if (process.platform !== 'win32') expect(processIdentity(process.pid)).toBeUndefined()
  })
  // The real kernel32 read, on the runner only: the cost it adds to a boot is exactly this call (the numbers go in the READY note).
  test.skipIf(process.platform !== 'win32')('windows: the creation time of a live process is stable, differs between processes, and costs well under 50 ms', async () => {
    const t0 = performance.now()
    const mine = processIdentity(process.pid)
    const cost = performance.now() - t0
    const again = processIdentity(process.pid)
    const child = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{},20000)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await Bun.sleep(300)
      const other = processIdentity(child.pid)
      const warm = performance.now()
      for (let i = 0; i < 100; i++) processIdentity(process.pid)
      const each = (performance.now() - warm) / 100
      console.log(`[F492] processIdentity: first call ${cost.toFixed(2)} ms, warm ${each.toFixed(3)} ms; mine=${mine} child=${other}`)
      expect(mine).toMatch(/^\d+$/)
      expect(again).toBe(mine)
      expect(other).toMatch(/^\d+$/)
      expect(other).not.toBe(mine)
      expect(cost).toBeLessThan(50)
    } finally {
      child.kill()
    }
    // the same pid read after the process is gone is no identity at all (never a stale one)
    await child.exited
    expect(processIdentity(child.pid)).toBeUndefined()
  })
})
