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
    reEmitJinja: mock(() => Promise.resolve()),
    clearIslandCache: mock(() => {}),
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
    expect(deps.reEmitJinja).toHaveBeenCalledTimes(1)
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('ts change ALSO rebuilds island chunks (island .tsx edits must hot-reload)', async () => {
    // Root-cause regression guard: the watcher's classifyPath NEVER emits
    // 'islands' — every .tsx (incl. an island's client source) is classified
    // 'ts'. So the 'ts' branch MUST rebuild island chunks, or editing an
    // island's JS never reaches the browser without a dev-server restart.
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/components/Counter.tsx'], kind: 'ts' })
    expect(deps.buildIslands).toHaveBeenCalledTimes(1)
  })

  test('css change → buildCss + broadcast building+css-update+ok, no worker restart', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/app.css'], kind: 'css' })
    expect(deps.workers.terminateAll).not.toHaveBeenCalled()
    expect(deps.reEmitJinja).not.toHaveBeenCalled()
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
    await c.handleChange({ paths: ['/components/Counter.tsx'], kind: 'islands' })
    expect(deps.buildIslands).toHaveBeenCalledTimes(1)
    expect(deps.reEmitJinja).toHaveBeenCalledTimes(1)
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('ISR cache is cleared on render-affecting reloads, not on css', async () => {
    // ts + islands edits must wipe the Rust-side island cache so a frozen
    // render never survives a hot reload; css-only changes leave it intact.
    const ts = makeDeps()
    await new Coordinator(ts).handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    expect(ts.clearIslandCache).toHaveBeenCalledTimes(1)

    const islands = makeDeps()
    await new Coordinator(islands).handleChange({
      paths: ['/components/Counter.tsx'],
      kind: 'islands',
    })
    expect(islands.clearIslandCache).toHaveBeenCalledTimes(1)

    const css = makeDeps()
    await new Coordinator(css).handleChange({ paths: ['/app.css'], kind: 'css' })
    expect(css.clearIslandCache).not.toHaveBeenCalled()
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
    expect(
      calls.find((c) => c.type === 'reload' || c.type === 'css-update' || c.type === 'ok'),
    ).toBeUndefined()
  })

  test('component-css change → buildComponentCss + css-update (no reload)', async () => {
    const baseManifest: any = {
      version: 1,
      modules: {
        '/p/x.module.css': {
          chunk: '/_brust/css/components/x.css',
          exports: { primary: 'primary_a' },
        },
      },
      routeChunks: {},
    }
    const deps = makeDeps({
      buildComponentCss: mock(() => Promise.resolve()),
      snapshotComponentCss: mock(() => Promise.resolve(baseManifest)),
    })
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/p/x.module.css'], kind: 'component-css' as any })
    const calls = deps.broadcast.mock.calls.map((c: any) => c[0])
    expect(calls[0].type).toBe('building')
    expect(calls.find((c: any) => c.type === 'css-update')).toBeDefined()
    expect(calls.find((c: any) => c.type === 'reload')).toBeUndefined()
  })

  test('component-css with exports-set change → reload (not css-update)', async () => {
    let snap = 0
    const before: any = {
      version: 1,
      routeChunks: {},
      modules: { '/p/x.module.css': { chunk: '/c.css', exports: { primary: 'p_a' } } },
    }
    const after: any = {
      version: 1,
      routeChunks: {},
      modules: {
        '/p/x.module.css': { chunk: '/c.css', exports: { primary: 'p_a', secondary: 's_a' } },
      },
    }
    const deps = makeDeps({
      buildComponentCss: mock(() => Promise.resolve()),
      snapshotComponentCss: mock(() => Promise.resolve(snap++ === 0 ? before : after)),
    })
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/p/x.module.css'], kind: 'component-css' as any })
    const calls = deps.broadcast.mock.calls.map((c: any) => c[0])
    expect(calls.find((c: any) => c.type === 'reload')).toBeDefined()
  })

  test('single-flight: change-while-building is dropped', async () => {
    let releaseTerm!: () => void
    let reachedTerm!: () => void
    // Signal the moment the first change reaches terminateAll, so the assertion
    // doesn't depend on how many `await`s precede it (e.g. the buildIslands hop).
    const atTerm = new Promise<void>((r) => {
      reachedTerm = r
    })
    const deps = makeDeps({
      workers: {
        terminateAll: mock(() => {
          reachedTerm()
          return new Promise<void>((r) => {
            releaseTerm = r
          })
        }),
        spawnAll: mock(() => Promise.resolve()),
      },
    })
    const c = new Coordinator(deps)
    const first = c.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    await atTerm // first is now blocked inside terminateAll (state === 'building')
    await c.handleChange({ paths: ['/b.tsx'], kind: 'ts' }) // dropped by the state guard
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    releaseTerm()
    await first
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
  })
})
