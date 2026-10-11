// M3-F E1 / R7 / R8: `dist/actions.js` bundle-level behaviour (the manifest + `brust build` wiring is
// appended by the next task). Out dirs live inside the package so the externals resolve at import.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadActionsApp } from '../src/actions/load'
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
