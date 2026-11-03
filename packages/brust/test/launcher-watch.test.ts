// F488: the launcher watch (process.ppid), with an injected platform / liveness (no Windows needed).
import { describe, expect, test } from 'bun:test'
import { watchLauncher } from '../src/launcher-watch'

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
  test('win32: the watched pid is the parent; stop() ends the poll', async () => {
    let fired = false
    const w = watchLauncher({ platform: 'win32', ppid: 7, alive: () => false === fired, intervalMs: 5, onGone: () => (fired = true) })
    expect(w.pid).toBe(7)
    w.stop()
    await Bun.sleep(25)
    expect(fired).toBe(false)
  })
})
