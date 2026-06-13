// R12 consumer gate — the load-bearing acceptance test for shipped .d.ts.
//
// Before this feature, `exports` pointed every subpath at raw .ts, so a
// consumer's `tsc` typechecked brust's INTERNALS (~70 errors they can't fix;
// skipLibCheck only skips .d.ts). The fix ships declaration files via a
// `types` condition per subpath. The only honest way to verify is the
// published-install path (dev repo masks published-install bugs — hoisted
// deps, source-tree resolution): pack a REAL TARBALL, install it into a fresh
// tmp project, typecheck a consumer file importing all 7 subpaths under
// strict:true + skipLibCheck:true, and require exit 0.
//
// Slow (packs + network install + tsc): generous timeouts, kept in the suite.

import { test, expect } from 'bun:test'
import path from 'node:path'
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { $ } from 'bun'

const REPO = path.resolve(import.meta.dir, '..')

// The 7 exports-map subpaths and the declaration file each one's `types`
// condition must resolve to (relative to the package root).
const EXPORTED_DTS: Record<string, string> = {
  '.': 'types/index.d.ts',
  './routes': 'types/routes.d.ts',
  './client': 'types/client/index.d.ts',
  './create': 'types/create.d.ts',
  './store': 'types/store/index.d.ts',
  './native': 'types/native/index.d.ts',
  './navigation': 'types/navigation/index.d.ts',
}

/** Exercises real types from every subpath. Typechecked strict:true in the
 * consumer project — if the shipped declarations (or the exports-map `types`
 * resolution) are broken, tsc fails here. */
const CONSUMER_TS = `\
// brustjs (root)
import { brust, cache, templates, Island } from 'brustjs'
import type { ServeOptions, CorsOptions, InvalidateArgs } from 'brustjs'
// brustjs/routes
import { defineRoutes, notFound, redirect, httpError } from 'brustjs/routes'
import type { Route, FlatRoute, NativeVerdict } from 'brustjs/routes'
// brustjs/client
import { client, BrustActionError } from 'brustjs/client'
import type { ClientOptions } from 'brustjs/client'
// brustjs/create
import { runNew } from 'brustjs/create'
// brustjs/store
import { signal, computed, effect, batch, defineStore } from 'brustjs/store'
import type { Signal, Computed } from 'brustjs/store'
// brustjs/native
import { register, start } from 'brustjs/native'
import type { Behavior, BehaviorCtx, Instance } from 'brustjs/native'
// brustjs/navigation
import { navigate, buildSearch, getNavState, onNavigate } from 'brustjs/navigation'
import type { NavState, NavigateOptions } from 'brustjs/navigation'

// root: serve options + dynamic templates + cache invalidation
const serveOpts: ServeOptions = { host: '127.0.0.1', port: 3000, workers: 1, entry: 'index.ts' }
const cors: CorsOptions = { origins: ['https://example.com'] }
serveOpts.cors = cors
void brust.serve
templates.register('page', '<h1>{{ title }}</h1>')
const html: string = templates.render('page', { title: 'hi' })
void html
const inv: InvalidateArgs = { tags: ['products'], path: '/products' }
cache.invalidate(inv)
void Island

// routes: defineRoutes + verdicts + httpError
const Page = (): null => null
const routes: Route[] = [
  {
    path: '/blog/{slug}',
    Component: Page,
    loader: async ({ params }) => {
      if (params.slug === 'gone') return notFound({ attempted: params.slug })
      if (params.slug === 'moved') return redirect('/blog/new', 301)
      if (params.slug === 'secret') throw httpError(403, 'no entry')
      return { slug: params.slug }
    },
  },
  { path: '*', Component: Page },
]
const flat: FlatRoute[] = defineRoutes(routes)
void flat
const verdict: NativeVerdict = notFound()
void verdict

// client: typed treaty client
const opts: ClientOptions = { baseUrl: 'http://localhost:3000' }
const api = client<Record<string, never>>(opts)
void api
void BrustActionError

// create
void runNew

// store: signals (call-style read, .set writes)
const count: Signal<number> = signal(0)
const double: Computed<number> = computed(() => count() * 2)
const dispose: () => void = effect(() => {
  void double()
  return () => {}
})
batch(() => {
  count.set(1)
})
count.set((prev) => prev + 1)
dispose()
const cart = defineStore('cart', () => ({ items: [] as string[] }))
void cart

// native: behavior registration
const behavior: Behavior = (ctx: BehaviorCtx): Instance => {
  ctx.onCleanup(() => {})
  return { el: ctx.el }
}
register('counter_abc12345', behavior)
void start

// navigation
const navOpts: NavigateOptions = {}
void navigate
const search: string = buildSearch({ q: 'shoes', page: 2 })
void search
const state: NavState = getNavState()
void state.phase
const off: () => void = onNavigate(() => {})
off()
`

test('dts consumer gate: packed tarball typechecks from all 7 subpaths (strict consumer)', async () => {
  // -- build:dts twice: idempotence is part of the contract (prepack reruns it)
  for (let i = 0; i < 2; i++) {
    const out = await $`bun run build:dts`.cwd(REPO).quiet().nothrow()
    expect(out.exitCode).toBe(0)
  }
  // every exports-map `types` target exists in the repo
  for (const rel of Object.values(EXPORTED_DTS)) {
    expect(existsSync(path.join(REPO, rel))).toBe(true)
  }
  // the package.json exports map actually names these targets, `types` first
  const pkg = await Bun.file(path.join(REPO, 'package.json')).json()
  for (const [subpath, rel] of Object.entries(EXPORTED_DTS)) {
    const entry = pkg.exports[subpath]
    const conditions = Object.keys(entry)
    expect(conditions[0]).toBe('types') // TS requires `types` before `default`
    expect(entry.types).toBe(`./${rel}`)
    expect(entry.default).toMatch(/^\.\/runtime\/.+\.ts$/) // Bun keeps executing raw .ts
  }

  const work = await mkdtemp(path.join(tmpdir(), 'brust-dts-consumer-'))
  try {
    // -- pack the REAL tarball (file: to the repo dir would symlink and mask
    //    files-allowlist/exports bugs — published-install-tarball lesson)
    const packed = await $`bun pm pack --destination ${work}`.cwd(REPO).quiet().nothrow()
    if (packed.exitCode !== 0) console.error('bun pm pack stderr:', packed.stderr.toString())
    expect(packed.exitCode).toBe(0)
    const tarball = (await readdir(work)).find((f) => f.endsWith('.tgz'))
    expect(tarball).toBeDefined()
    const tarballPath = path.join(work, tarball as string)

    // tarball must contain the declaration tree the exports map points at
    const listing = await $`tar -tzf ${tarballPath}`.quiet().text()
    for (const rel of Object.values(EXPORTED_DTS)) {
      expect(listing).toContain(`package/${rel}`)
    }

    // -- fresh consumer project installing the tarball
    const app = path.join(work, 'consumer-app')
    await mkdir(app)
    await writeFile(
      path.join(app, 'package.json'),
      JSON.stringify(
        {
          name: 'brust-dts-consumer',
          private: true,
          type: 'module',
          dependencies: {
            brustjs: `file:${tarballPath}`,
            react: '^19.2.6',
            'react-dom': '^19.2.6',
          },
          devDependencies: {
            '@types/bun': 'latest',
            '@types/react': '^19.2.15',
            '@types/react-dom': '^19.2.3',
          },
        },
        null,
        2,
      ),
    )
    await writeFile(
      path.join(app, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      ),
    )
    await writeFile(path.join(app, 'consumer.ts'), CONSUMER_TS)

    const install = await $`bun install`.cwd(app).quiet().nothrow()
    if (install.exitCode !== 0) {
      console.error('bun install failed:', install.stderr.toString())
    }
    expect(install.exitCode).toBe(0)

    // -- THE GATE: the consumer's strict tsc must exit 0. Run the typescript
    //    the tarball itself pins (brustjs ships typescript as a dependency),
    //    i.e. exactly what a consumer resolves.
    const tscBin = path.join(app, 'node_modules', 'typescript', 'bin', 'tsc')
    expect(existsSync(tscBin)).toBe(true)
    const tsc = await $`bun ${tscBin} -p tsconfig.json`.cwd(app).quiet().nothrow()
    if (tsc.exitCode !== 0) {
      console.error('consumer tsc failed:\n', tsc.stdout.toString(), tsc.stderr.toString())
    }
    expect(tsc.exitCode).toBe(0)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}, 300_000)
