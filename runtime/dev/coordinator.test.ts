import { describe, test, expect, mock } from 'bun:test'
import { Coordinator } from './coordinator.ts'

function makeDeps(over: Partial<any> = {}) {
  return {
    workers: {
      terminateAll: mock(() => Promise.resolve()),
      spawnAll: mock(() => Promise.resolve()),
    },
    buildCss: mock(() => Promise.resolve()),
    buildIslands: mock(() => Promise.resolve()),
    broadcast: mock((_msg: any) => Promise.resolve()),
    tui: { appendEvent: mock((_line: string) => {}) },
    ...over,
  }
}

describe('Coordinator', () => {
  test('ts change → terminate, spawn, broadcast building+reload+ok', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('css change → buildCss + broadcast building+css-update+ok, no worker restart', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/app.css'], kind: 'css' })
    expect(deps.workers.terminateAll).not.toHaveBeenCalled()
    expect(deps.buildCss).toHaveBeenCalledTimes(1)
    const calls = deps.broadcast.mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe('building')
    expect(calls[1].type).toBe('css-update')
    expect(calls[1].href).toMatch(/^\/_brust\/css\/app\.css\?v=\d+$/)
    expect(calls[2].type).toBe('ok')
  })

  test('islands change → buildIslands + worker restart + reload', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/island.config.ts'], kind: 'islands' })
    expect(deps.buildIslands).toHaveBeenCalledTimes(1)
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('build failure → broadcast error, no reload/ok', async () => {
    const deps = makeDeps({
      buildCss: mock(() => Promise.reject(new Error('Tailwind broke'))),
    })
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/app.css'], kind: 'css' })
    const calls = deps.broadcast.mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe('building')
    expect(calls[1].type).toBe('error')
    expect(calls[1].message).toBe('Tailwind broke')
    expect(calls.find((c) => c.type === 'reload' || c.type === 'css-update' || c.type === 'ok')).toBeUndefined()
  })

  test('single-flight: change-while-building is dropped', async () => {
    let releaseTerm!: () => void
    const deps = makeDeps({
      workers: {
        terminateAll: mock(() => new Promise<void>((r) => { releaseTerm = r })),
        spawnAll: mock(() => Promise.resolve()),
      },
    })
    const c = new Coordinator(deps)
    const first = c.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    await c.handleChange({ paths: ['/b.tsx'], kind: 'ts' })
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    releaseTerm()
    await first
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
  })
})
