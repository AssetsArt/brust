import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyTemplate } from '../src/copy.ts'

const dirs: string[] = []
const tmp = async (p: string) => { const d = await mkdtemp(path.join(tmpdir(), p)); dirs.push(d); return d }
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

test('copyTemplate: strips .tmpl suffix and substitutes', async () => {
  const tmpl = await tmp('ca-src-'); const target = await tmp('ca-dst-')
  await Bun.write(path.join(tmpl, 'a.txt'), 'static content\n')
  await Bun.write(path.join(tmpl, 'b.txt.tmpl'), 'name=__PROJECT_NAME__\n')
  await Bun.write(path.join(tmpl, '_gitignore'), 'node_modules/\n')
  await copyTemplate({ templateDir: tmpl, targetDir: target, substitutions: { __PROJECT_NAME__: 'hello' } })
  expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('static content\n')
  expect(await readFile(path.join(target, 'b.txt'), 'utf8')).toBe('name=hello\n')
  expect(await readFile(path.join(target, '.gitignore'), 'utf8')).toBe('node_modules/\n')
  const entries = await readdir(target)
  expect(entries).not.toContain('_gitignore')
  expect(entries).not.toContain('b.txt.tmpl')
})

test('copyTemplate: recurses into subdirectories', async () => {
  const tmpl = await tmp('ca-src-'); const target = await tmp('ca-dst-')
  await Bun.write(path.join(tmpl, 'sub/nested.txt'), 'deep\n')
  await Bun.write(path.join(tmpl, 'sub/deep.tmpl'), 'X=__X__')
  await copyTemplate({ templateDir: tmpl, targetDir: target, substitutions: { __X__: '42' } })
  expect(await readFile(path.join(target, 'sub/nested.txt'), 'utf8')).toBe('deep\n')
  expect(await readFile(path.join(target, 'sub/deep'), 'utf8')).toBe('X=42')
})

test('copyTemplate: throws if templateDir missing', async () => {
  await expect(copyTemplate({ templateDir: '/no/such/dir', targetDir: '/tmp/whatever', substitutions: {} })).rejects.toThrow(/template directory not found/)
})

test('_gitignore → .gitignore; a nested _gitignore too', async () => {
  const tmpl = await tmp('ca-src-'); const target = await tmp('ca-dst-')
  await Bun.write(path.join(tmpl, '_gitignore'), 'a\n')
  await Bun.write(path.join(tmpl, 'sub/_gitignore'), 'b\n')
  await copyTemplate({ templateDir: tmpl, targetDir: target, substitutions: {} })
  expect(await readFile(path.join(target, '.gitignore'), 'utf8')).toBe('a\n')
  expect(await readFile(path.join(target, 'sub/.gitignore'), 'utf8')).toBe('b\n')
})

test('non-.tmpl files are copied byte-for-byte (a binary file round-trips) and never substituted', async () => {
  const tmpl = await tmp('ca-src-'); const target = await tmp('ca-dst-')
  const bin = new Uint8Array([0, 255, 1, 254, 95, 95, 80])
  await Bun.write(path.join(tmpl, 'x.bin'), bin)
  await Bun.write(path.join(tmpl, 'keep.txt'), 'raw __PROJECT_NAME__\n')
  await copyTemplate({ templateDir: tmpl, targetDir: target, substitutions: { __PROJECT_NAME__: 'z' } })
  expect(new Uint8Array(await readFile(path.join(target, 'x.bin')))).toEqual(bin)
  expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('raw __PROJECT_NAME__\n')
})

test('__BRUST_DEP__ substitution yields valid JSON', async () => {
  const tmpl = await tmp('ca-src-'); const target = await tmp('ca-dst-')
  await Bun.write(path.join(tmpl, 'package.json.tmpl'), '{ "dependencies": { "@brust/core": __BRUST_DEP__ } }\n')
  const spec = 'file:/a b"c'
  await copyTemplate({ templateDir: tmpl, targetDir: target, substitutions: { __BRUST_DEP__: JSON.stringify(spec) } })
  expect(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).dependencies['@brust/core']).toBe(spec)
})
