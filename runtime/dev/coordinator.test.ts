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
    validateChanges: mock((_paths: string[]) => Promise.resolve()),
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

  test('md change → island rebuild + worker restart + reEmitJinja + reload (same path as ts)', async () => {
    // Task 2.9: an .md edit must take the FULL ts-edit path. buildIslands
    // (wired in index.ts) re-runs emitMdArtifacts — the re-splice; the worker
    // restart is REQUIRED because loadIslandManifest caches per-isolate
    // (islands/native-render.ts), so a re-emitted .islands.json sidecar is
    // never re-read by a live worker.
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/content/docs/guide.md'], kind: 'md' })
    expect(deps.clearIslandCache).toHaveBeenCalledTimes(1)
    expect(deps.buildIslands).toHaveBeenCalledTimes(1)
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    expect(deps.reEmitJinja).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('valid full reload validates before build, jinja re-emit, and worker replacement', async () => {
    // S1 regression guard: napiLoadJinjaTemplates operates on the PROCESS-GLOBAL
    // Rust minijinja env, not on the workers — so the templates must be reloaded
    // before spawnAll, or the fresh workers serve the OLD jinja for the window
    // between spawn and re-emit. The WS reload stays last (after spawnAll).
    const order: string[] = []
    const deps = makeDeps({
      validateChanges: mock(async () => {
        order.push('validate')
      }),
      buildIslands: mock(async () => {
        order.push('buildIslands')
      }),
      reEmitJinja: mock(async () => {
        order.push('reEmitJinja')
      }),
      workers: {
        terminateAll: mock(async () => {
          order.push('terminateAll')
        }),
        spawnAll: mock(async () => {
          order.push('spawnAll')
        }),
      },
      broadcast: mock(async (msg: any) => {
        if (msg.type === 'reload') order.push('reload')
      }),
    })
    // The reorder applies to the WHOLE shared ts/html/islands/md branch.
    for (const kind of ['ts', 'html', 'islands', 'md'] as const) {
      order.length = 0
      await new Coordinator(deps).handleChange({ paths: ['/x'], kind })
      expect(order).toEqual([
        'validate',
        'buildIslands',
        'reEmitJinja',
        'terminateAll',
        'spawnAll',
        'reload',
      ])
    }
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

  test('validation failure broadcasts error before any live-generation mutation', async () => {
    const deps = makeDeps({
      validateChanges: mock(() => Promise.reject(new Error('invalid /a.tsx'))),
    })
    const coordinator = new Coordinator(deps)
    await coordinator.handleChange({ paths: ['/a.tsx'], kind: 'ts' })

    expect(deps.validateChanges).toHaveBeenCalledWith(['/a.tsx'])
    expect(deps.clearIslandCache).not.toHaveBeenCalled()
    expect(deps.buildIslands).not.toHaveBeenCalled()
    expect(deps.reEmitJinja).not.toHaveBeenCalled()
    expect(deps.workers.terminateAll).not.toHaveBeenCalled()
    expect(deps.workers.spawnAll).not.toHaveBeenCalled()
    expect(deps.broadcast.mock.calls.map((call) => call[0].type)).toEqual(['building', 'error'])
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

  test('a change arriving while building is replayed before the active drain resolves', async () => {
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
          if (!releaseTerm) {
            reachedTerm()
            return new Promise<void>((r) => {
              releaseTerm = r
            })
          }
          return Promise.resolve()
        }),
        spawnAll: mock(() => Promise.resolve()),
      },
    })
    const c = new Coordinator(deps)
    const first = c.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    await atTerm // first is now blocked inside terminateAll (state === 'building')
    const second = c.handleChange({ paths: ['/b.tsx'], kind: 'ts' })
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    releaseTerm()
    await Promise.all([first, second])
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(2)
  })

  test('same-domain events arriving during a build merge into one replay', async () => {
    let releaseFirst!: () => void
    let firstReached!: () => void
    const reached = new Promise<void>((resolve) => {
      firstReached = resolve
    })
    let blocked = false
    const deps = makeDeps({
      buildIslands: mock(() => {
        if (!blocked) {
          blocked = true
          firstReached()
          return new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve()
      }),
    })
    const coordinator = new Coordinator(deps)
    const first = coordinator.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    await reached
    const replay = [
      coordinator.handleChange({ paths: ['/b.tsx'], kind: 'ts' }),
      coordinator.handleChange({ paths: ['/b.tsx', '/c.html'], kind: 'html' }),
      coordinator.handleChange({ paths: ['/c.html'], kind: 'html' }),
    ]
    releaseFirst()
    await Promise.all([first, ...replay])

    expect(deps.buildIslands).toHaveBeenCalledTimes(2)
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(2)
  })

  test('full kinds coalesce while app and component CSS drain independently in priority order', async () => {
    const order: string[] = []
    const deps = makeDeps({
      buildIslands: mock(async () => order.push('full')),
      buildCss: mock(async () => order.push('app-css')),
      buildComponentCss: mock(async () => order.push('component-css')),
    })
    const coordinator = new Coordinator(deps)
    await Promise.all([
      coordinator.handleChange({ paths: ['/x.module.css'], kind: 'component-css' }),
      coordinator.handleChange({ paths: ['/guide.md'], kind: 'md' }),
      coordinator.handleChange({ paths: ['/app.css'], kind: 'css' }),
      coordinator.handleChange({ paths: ['/a.tsx'], kind: 'ts' }),
      coordinator.handleChange({ paths: ['/index.html'], kind: 'html' }),
      coordinator.handleChange({ paths: ['/Island.tsx'], kind: 'islands' }),
    ])

    expect(order).toEqual(['full', 'app-css', 'component-css'])
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
  })

  test('an error in the first batch does not discard a pending later domain', async () => {
    const deps = makeDeps({
      buildIslands: mock(() => Promise.reject(new Error('island build failed'))),
    })
    const coordinator = new Coordinator(deps)
    await Promise.all([
      coordinator.handleChange({ paths: ['/a.tsx'], kind: 'ts' }),
      coordinator.handleChange({ paths: ['/app.css'], kind: 'css' }),
    ])

    expect(deps.buildCss).toHaveBeenCalledTimes(1)
    expect(deps.broadcast.mock.calls.map((call) => call[0].type)).toEqual([
      'building',
      'error',
      'building',
      'css-update',
      'ok',
    ])
  })
})
