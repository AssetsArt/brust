// F488: the launcher watch, with an injected platform / process table / liveness (no Windows needed).
import { describe, expect, test } from 'bun:test'
import { launcherChain, type ProcRow, watchLauncher } from '../src/launcher-watch'

// The chain probed on windows-latest (PR #428): smoke -> bash, and wrapper -> shim -> server.
const rows: ProcRow[] = [
  { pid: 1, ppid: 0, name: 'Runner.Worker.exe' },
  { pid: 2, ppid: 1, name: 'bash.exe' },
  { pid: 3, ppid: 2, name: 'bun.exe' },
  { pid: 4, ppid: 3, name: 'bun.exe' }, // `bun run start`
  { pid: 5, ppid: 4, name: 'brust.exe' }, // .bin shim
  { pid: 6, ppid: 5, name: 'bun.exe' }, // the server
]

describe('launcherChain', () => {
  test('the contiguous bun-family ancestors, nearest first, stopping at a shell', () => {
    expect(launcherChain(rows, 6)).toEqual([5, 4, 3])
  })
  test('a server started from a shell has no launcher to watch', () => {
    expect(launcherChain([{ pid: 9, ppid: 2, name: 'bun.exe' }, rows[1]!], 9)).toEqual([])
  })
  test('a dead (missing) parent ends the chain; a cycle from a reused pid cannot loop', () => {
    expect(launcherChain([{ pid: 6, ppid: 5, name: 'bun.exe' }], 6)).toEqual([])
    expect(launcherChain([{ pid: 6, ppid: 5, name: 'bun.exe' }, { pid: 5, ppid: 6, name: 'brust.exe' }], 6)).toEqual([5])
  })
  test('image match is case-insensitive and exact', () => {
    expect(launcherChain([{ pid: 2, ppid: 1, name: 'bunx-helper.exe' }, { pid: 3, ppid: 2, name: 'bun.exe' }], 3)).toEqual([])
    expect(launcherChain([{ pid: 2, ppid: 1, name: 'BUN.EXE' }, { pid: 3, ppid: 2, name: 'bun' }], 3)).toEqual([2])
  })
})

describe('watchLauncher', () => {
  test('POSIX: reads nothing, watches nothing', async () => {
    let read = false
    const w = await watchLauncher({ platform: 'linux', onGone: () => {}, readTable: async () => ((read = true), rows) })
    expect(read).toBe(false)
    expect(w.pids).toEqual([])
  })
  test('win32: onGone fires once, with the first watched pid that disappears', async () => {
    const up = new Set([3, 4, 5])
    const gone: number[] = []
    const done = new Promise<void>((r) => {
      void watchLauncher({ platform: 'win32', self: 6, readTable: async () => rows, alive: (p) => up.has(p), intervalMs: 5, onGone: (p) => (gone.push(p), r()) })
    })
    await Bun.sleep(30)
    expect(gone).toEqual([]) // everything alive: nothing fires
    up.delete(4) // the wrapper is killed
    await done
    await Bun.sleep(30)
    expect(gone).toEqual([4])
  })
  test('win32: an unreadable process table watches nothing and never throws', async () => {
    const w = await watchLauncher({ platform: 'win32', onGone: () => {}, readTable: async () => { throw new Error('no powershell') } })
    expect(w.pids).toEqual([])
  })
  test('win32: the poll timer is unref()d (does not hold the process open)', async () => {
    const w = await watchLauncher({ platform: 'win32', self: 6, readTable: async () => rows, alive: () => true, intervalMs: 5, onGone: () => {} })
    expect(w.pids).toEqual([5, 4, 3])
    w.stop()
  })
})
