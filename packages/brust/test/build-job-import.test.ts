// F186: `brust-job:<id>` resolves only for a staged job file, and only to a known id.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jobImportPlugin } from '../src/build/bundle'

let dir = ''
let job = '' // a staged job module (the allowed importer)
let target = '' // the module `brust-job:child` resolves to
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'brust-job-import-')))
  mkdirSync(join(dir, 'jobs'))
  target = join(dir, 'jobs', 'child.server.ts')
  writeFileSync(target, 'export const precompute = () => ({ _s1: "child" })\n')
  job = join(dir, 'jobs', 'parent.server.ts')
  writeFileSync(job, 'import { precompute as c } from "brust-job:child"\nexport const precompute = () => c()\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const plugin = () => jobImportPlugin((id) => (id === 'child' ? target : undefined), (importer) => importer === job)
const bundle = (entry: string) => Bun.build({ entrypoints: [entry], target: 'bun', plugins: [plugin()], throw: false })

test('a staged job module imports a known job id', async () => {
  const r = await bundle(job)
  expect(r.success).toBe(true)
  expect(await r.outputs[0]!.text()).toContain('"child"')
})

test('hostile: an app module cannot import brust-job:', async () => {
  const app = join(dir, 'app.ts')
  writeFileSync(app, 'import { precompute } from "brust-job:child"\nexport default precompute\n')
  const r = await bundle(app)
  expect(r.success).toBe(false)
  expect(r.logs.map(String).join('\n')).toContain('generated job modules only')
})

test('hostile: a package file in node_modules cannot import brust-job:', async () => {
  mkdirSync(join(dir, 'node_modules', 'evil'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'evil', 'package.json'), '{"name":"evil","version":"1.0.0","main":"index.js"}')
  writeFileSync(join(dir, 'node_modules', 'evil', 'index.js'), 'export { precompute } from "brust-job:child"\n')
  const entry = join(dir, 'uses-evil.ts')
  writeFileSync(entry, 'export * from "./node_modules/evil/index.js"\n')
  const r = await bundle(entry)
  expect(r.success).toBe(false)
  expect(r.logs.map(String).join('\n')).toContain('generated job modules only')
})

test('hostile: a staged job module still cannot name an unknown or malformed id', async () => {
  for (const id of ['nope', '../child', 'child/../child', 'child ', '']) {
    writeFileSync(job, `import { precompute } from ${JSON.stringify(`brust-job:${id}`)}\nexport default precompute\n`)
    const r = await bundle(job)
    expect(r.success).toBe(false)
    expect(r.logs.map(String).join('\n')).toContain('no job module for')
  }
})
