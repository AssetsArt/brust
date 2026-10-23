// L23 (lucide-native): lucide-react icons are rendered at build time to inline SVG (static and native
// components: no worker, no React island); the markup equals React's byte for byte for the installed
// version (lucide-react 1.x). A non-constant size / color / strokeWidth / className is lowered back to an
// attribute; anything else keeps the L22 island, with a diagnostic.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Edit, Heart, LucideProvider, Plus, Star } from 'lucide-react'
import InlinedCond from './fixtures/lucide/InlinedCond'

const app = join(import.meta.dir, 'fixtures/lucide')
const bin = join(import.meta.dir, '../bin/brust')
let build: { exitCode: number; stderr: { toString(): string }; stdout: { toString(): string } }
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''

const manifest = () => JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string; needs_worker: boolean; client: string | null; jobs: { kind: string }[] }> }
const comp = (prefix: string) => Object.entries(manifest().components).find(([id]) => id.startsWith(prefix))![1]
const html = async (path: string) => (await fetch(`${base}${path}`)).text()
const react = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

beforeAll(async () => {
  build = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' }) as typeof build
  if (build.exitCode !== 0) throw new Error(`brust build failed:\n${build.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
}, 180_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) proc.kill('SIGKILL')
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('static page: literal icons need no worker, no job, no client chunk, and equal React byte for byte (alias and deep import included)', async () => {
  const c = comp('static_')
  expect(c.needs_worker).toBe(false)
  expect(c.jobs).toEqual([])
  expect(c.client).toBeNull()
  const page = await html('/')
  const lit = [
    react(createElement(Heart, { size: 16, color: 'red', strokeWidth: 1.5, className: 'love', 'aria-label': 'loved' })),
    react(createElement(Plus)),
    react(createElement(Edit, { size: 20 })),
    react(createElement(Star, { nonScalingStroke: true })),   // lucide-react 1.x
  ].join('')
  expect(page).toContain(lit)
  expect(page).not.toContain('brust-island')
})

test('a non-constant size / color / strokeWidth / className is lowered to attributes (static page: Jinja)', async () => {
  const page = await html('/')
  expect(page).toContain(react(createElement(Heart, { size: 40, color: 'teal', strokeWidth: 1, className: 'ico teal' })))
})

test('an undefined size / color / strokeWidth / className renders React\'s defaults, the provider\'s values included', async () => {
  const page = await html('/undefined')
  expect(page).toContain(react(createElement(Heart, {})))   // width 24, stroke currentColor, stroke-width 2, class "lucide lucide-heart"
  expect(page).toContain(react(createElement(LucideProvider, { size: 32, color: 'green', strokeWidth: 3, children: createElement(Heart, {}) })))
  // and with values present the same route renders them
  const defined = await html('/defined')
  expect(defined).toContain(react(createElement(Heart, { size: 12, color: 'navy', strokeWidth: 1, className: 'k1' })))
  expect(defined).toContain(react(createElement(LucideProvider, { size: 32, color: 'green', strokeWidth: 3, children: createElement(Heart, { size: 12, color: 'navy', strokeWidth: 1 }) })))
})

test('a literal LucideProvider is applied at build; no island, no worker', async () => {
  const c = comp('provider_')
  expect(c.needs_worker).toBe(false)
  const page = await html('/provider')
  const want = react(createElement(LucideProvider, { size: 32, color: 'green', strokeWidth: 3, children: [createElement(Heart, { key: 'h' }), createElement(Plus, { key: 'p', size: 10 })] }))
  expect(page).toContain(want)
  expect(page).not.toContain('brust-island')
})

test('a dynamic LucideProvider and an icon with a non-lowerable prop fall back to the L22 island, with a diagnostic', async () => {
  const log = build.stderr.toString() + build.stdout.toString()
  expect(log).toMatch(/warning icon-provider-dynamic DynamicProvider\.tsx:\d+:\d+ LucideProvider prop `size`/)
  expect(log).toMatch(/warning icon-dynamic-prop Fallback\.tsx:\d+:\d+ icon prop `aria-label`/)
  // still rendered (server) as an island
  expect(await html('/fallback')).toContain('<brust-island')
  expect(await html('/dynprovider')).toContain('<brust-island')
})

test('the native page keeps the icon as inline SVG with state-driven attributes (no island, no worker)', async () => {
  const c = comp('native_')
  expect(c.tier).toBe('native')
  expect(c.needs_worker).toBe(false)
  const page = await html('/native')
  // the first paint equals React's; the extra attributes are the client's bindings
  expect(page.replace(/ x-bind-[a-z-]+="[^"]*"/g, '')).toContain(react(createElement(Heart, { size: 16, color: 'red' })))
  for (const a of ['x-bind-width', 'x-bind-height', 'x-bind-stroke']) expect(page).toContain(a)
  expect(page).not.toContain('brust-island')
})

test('F407: a static component with an icon, under a condition inside an inlined component with its own icon, builds and paints as React', async () => {
  // Red before: the first compile saw both icons as island jobs and failed the build with nested-instance.
  for (const [path, interactive] of [['/inlined-cond', true], ['/inlined-cond-off', false]] as const) {
    const page = await html(path)
    expect(page).toContain(react(createElement(InlinedCond, { post: { href: '/p', interactive } })))
    expect(page).not.toContain('brust-island')
  }
  expect(comp('inlinedCond_').jobs).toEqual([])
  expect(comp('inlinedCond_').needs_worker).toBe(false)
})
