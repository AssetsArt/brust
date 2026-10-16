// M3-F E1 / R7 / R8: `dist/actions.js` bundle-level behaviour (the manifest + `brust build` wiring is
// appended by the next task). Out dirs live inside the package so the externals resolve at import.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadActionsApp } from '../src/actions/load'
import { runBuild } from '../src/build'
import { buildActions } from '../src/build/bundle'

const dirs: string[] = []
const localDir = () => {
  const d = mkdtempSync(join(import.meta.dir, '.tmp-out-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const HELLO = `import { Elysia } from 'elysia'
import { brust } from '@brust/core/elysia'
export default new Elysia({ adapter: brust() }).get('/hello', () => 'hi')
`

function setup(files: Record<string, string>) {
  const src = localDir()
  const out = localDir()
  mkdirSync(out, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text)
  return { src, out }
}

test('buildActions writes dist/actions.js with elysia and @brust/core external', async () => {
  const { src, out } = setup({ 'actions.ts': HELLO })
  expect(await buildActions(out, join(src, 'actions.ts'))).toBe('actions.js')
  const text = readFileSync(join(out, 'actions.js'), 'utf8')
  expect(text).toContain('from "elysia"')
  expect(text).toContain('from "@brust/core/elysia"')
  expect(text).not.toContain('class Elysia')
})

test("the bundled module's default export mounts and answers", async () => {
  const { src, out } = setup({ 'actions.ts': HELLO })
  await buildActions(out, join(src, 'actions.ts'))
  const app = await loadActionsApp(join(out, 'actions.js'), '/p')
  const res = await app.handle(new Request('http://x/p/hello'))
  expect(res.status).toBe(200)
})

test("a store imported by the actions entry stays the worker's @brust/core/store", async () => {
  const { src, out } = setup({
    'actions.ts': `import { signal } from '@brust/runtime-dom/store'\n${HELLO}\nexport const s = signal(1)\n`,
  })
  await buildActions(out, join(src, 'actions.ts'))
  expect(readFileSync(join(out, 'actions.js'), 'utf8')).toContain('from "@brust/core/store"')
})

test('a relative import of the entry is bundled', async () => {
  const { src, out } = setup({
    'lib.ts': `export const greeting = 'hello'\n`,
    'actions.ts': `import { greeting } from './lib.ts'\nimport { Elysia } from 'elysia'\nimport { brust } from '@brust/core/elysia'\nexport default new Elysia({ adapter: brust() }).get('/hello', () => greeting)\n`,
  })
  await buildActions(out, join(src, 'actions.ts'))
  const text = readFileSync(join(out, 'actions.js'), 'utf8')
  expect(text).not.toContain('from "./lib')
  expect(text).toContain('hello')
})

// ---- build-level: manifest.actions, the route/prefix shadow check, the browser guard ----

const ROUTES = (extra = '') =>
  `import { defineRoutes } from '@brust/core/routes'\nimport Home from './Home'\n${extra}export const routes = defineRoutes([{ path: '/', Component: Home }${extra ? ', { path: "/api/docs", Component: Home }' : ''}])\n`
const NATIVE_HOME = `import { useState } from 'react'\nexport default function Home() {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>n={n}</button>\n}\n`

/** A throwaway app inside the package (so `elysia` and `@brust/core/elysia` resolve). */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-app-'))
  dirs.push(dir)
  const all = { 'routes.tsx': ROUTES(), 'Home.tsx': NATIVE_HOME, ...files }
  for (const [name, text] of Object.entries(all)) writeFileSync(join(dir, name), text)
  return dir
}
const build = (dir: string, out: string) => runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: out, log: () => {} })
const clientText = (out: string) =>
  readdirSync(join(out, 'client'))
    .map((f) => readFileSync(join(out, 'client', f), 'utf8'))
    .join('\n')

test('an app with [actions] gets manifest.actions and dist/actions.js', async () => {
  const dir = app({ 'brust.toml': '[actions]\nprefix = "/api"\nmax_body_bytes = 1024\n', 'actions.ts': HELLO })
  const out = join(dir, 'dist')
  await build(dir, out)
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  expect(m.actions).toEqual({ entry: 'actions.js', prefix: '/api', maxBodyBytes: 1024, maxResponseBytes: 8388608, crossSite: 'reject' })
  expect(existsSync(join(out, 'actions.js'))).toBe(true)
}, 60_000)

test('an app without [actions] gets "actions": null and no actions.js', async () => {
  const dir = app({ 'actions.ts': HELLO })
  const out = join(dir, 'dist')
  await build(dir, out)
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  expect(m.actions).toBeNull()
  expect(existsSync(join(out, 'actions.js'))).toBe(false)
}, 60_000)

test('a missing entry file fails before anything is written', async () => {
  const dir = app({ 'brust.toml': '[actions]\nentry = "nope.ts"\n' })
  const out = join(dir, 'dist')
  mkdirSync(out)
  writeFileSync(join(out, 'manifest.json'), '{"old":true}')
  writeFileSync(join(out, '.brust'), '')
  await expect(build(dir, out)).rejects.toMatchObject({ rule: 'actions-entry', message: 'actions.entry nope.ts is not a file inside the app' })
  expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe('{"old":true}')
}, 60_000)

test('a literal route under the prefix is refused; a root catch-all is not', async () => {
  const toml = '[actions]\nprefix = "/api"\n'
  const bad = app({ 'brust.toml': toml, 'actions.ts': HELLO, 'routes.tsx': ROUTES('// docs\n') })
  await expect(build(bad, join(bad, 'dist'))).rejects.toMatchObject({
    rule: 'actions-prefix',
    message: expect.stringContaining('lies under the actions prefix /api'),
  })
  const ok = app({
    'brust.toml': toml,
    'actions.ts': HELLO,
    'routes.tsx': `import { defineRoutes } from '@brust/core/routes'\nimport Home from './Home'\nexport const routes = defineRoutes([{ path: '/', Component: Home }, { path: '*', Component: Home }])\n`,
  })
  await build(ok, join(ok, 'dist'))
  expect(existsSync(join(ok, 'dist', 'actions.js'))).toBe(true)
}, 60_000)

const ISLAND_ROUTES = `import { defineRoutes } from '@brust/core/routes'\nimport Island from './Island'\nexport const routes = defineRoutes([{ path: '/', Component: Island, loader: () => ({ label: 'x' }) }])\n`
const ISLAND = (imp: string, use: string) =>
  `import { useReducer, useTransition } from 'react'\n${imp}\nexport default function Island(props: { label: string }) {\n  useTransition(); const [n, bump] = useReducer((x: number) => x + 1, 0)\n  return <b onClick={() => { bump(); console.log(${use}) }}>{props.label}:{n}</b>\n}\n`

test('a react island importing the actions module (value) fails with server-only-in-client', async () => {
  const dir = app({
    'brust.toml': '[actions]\n',
    'actions.ts': HELLO,
    'routes.tsx': ISLAND_ROUTES,
    'Island.tsx': ISLAND("import actions from './actions'", 'actions'),
  })
  await expect(build(dir, join(dir, 'dist'))).rejects.toMatchObject({
    rule: 'server-only-in-client',
    message: expect.stringContaining('Island.tsx imports ./actions'),
  })
}, 60_000)

test('a native component importing only the App TYPE plus client<App>() builds', async () => {
  const dir = app({
    'brust.toml': '[actions]\n',
    'actions.ts': HELLO,
    'Home.tsx': `import { useState } from 'react'\nimport { client } from '@brust/core/client'\nimport type { App } from './actions'\nexport default function Home() {\n  const [n, setN] = useState(0)\n  return <button onClick={async () => { await client<App>().hello.get(); setN(n + 1) }}>n={n}</button>\n}\n`,
  })
  writeFileSync(join(dir, 'actions.ts'), `${HELLO.replace('export default new Elysia', 'const app = new Elysia')}\nexport type App = typeof app\nexport default app\n`)
  const out = join(dir, 'dist')
  await build(dir, out)
  expect(clientText(out)).not.toContain('class Elysia')
}, 60_000)

test('a react island importing @brust/core/elysia or elysia fails with server-only-in-client', async () => {
  for (const [imp, use] of [
    ["import { brust } from '@brust/core/elysia'", 'brust'],
    ["import { Elysia } from 'elysia'", 'Elysia'],
  ] as const) {
    const dir = app({ 'routes.tsx': ISLAND_ROUTES, 'Island.tsx': ISLAND(imp, use) })
    await expect(build(dir, join(dir, 'dist'))).rejects.toMatchObject({ rule: 'server-only-in-client' })
  }
}, 60_000)
