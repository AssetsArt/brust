import { test, expect } from 'bun:test'
import { parseArgs, resolveBrustRef, copyTemplate } from '../runtime/cli/new.ts'
import path from 'node:path'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

test('parseArgs: positional name → targetDir = cwd/<name>', () => {
  const result = parseArgs(['my-app'])
  expect(result.projectName).toBe('my-app')
  expect(result.targetDir).toBe(path.resolve(process.cwd(), 'my-app'))
})

test('parseArgs: --dir overrides target', () => {
  const result = parseArgs(['my-app', '--dir', '/tmp/foo'])
  expect(result.targetDir).toBe('/tmp/foo')
})

test('parseArgs: --dir=value form', () => {
  const result = parseArgs(['my-app', '--dir=/tmp/bar'])
  expect(result.targetDir).toBe('/tmp/bar')
})

test('parseArgs: relative --dir resolved against cwd', () => {
  const result = parseArgs(['my-app', '--dir', './subdir'])
  expect(result.targetDir).toBe(path.resolve(process.cwd(), 'subdir'))
})

test('parseArgs: missing name throws', () => {
  expect(() => parseArgs([])).toThrow(/missing project name/)
})

test('parseArgs: unknown flag throws', () => {
  expect(() => parseArgs(['my-app', '--bogus'])).toThrow(/unknown flag/)
})

test('parseArgs: --dir without value throws', () => {
  expect(() => parseArgs(['my-app', '--dir'])).toThrow(/--dir requires a value/)
})

test('parseArgs: invalid project name throws (uppercase)', () => {
  expect(() => parseArgs(['MyApp'])).toThrow(/invalid project name/)
})

test('parseArgs: invalid project name throws (starts with hyphen)', () => {
  expect(() => parseArgs(['-foo'])).toThrow(/unknown flag/)
})

test('parseArgs: invalid project name throws (space)', () => {
  expect(() => parseArgs(['foo bar'])).toThrow(/invalid project name/)
})

test('parseArgs: digit-start name is valid', () => {
  const result = parseArgs(['1-foo'])
  expect(result.projectName).toBe('1-foo')
})

test('parseArgs: name too long throws', () => {
  const long = 'a'.repeat(51)
  expect(() => parseArgs([long])).toThrow(/too long/)
})

test('resolveBrustRef: detects source tree (this repo)', () => {
  const ref = resolveBrustRef()
  expect(ref.kind).toBe('file')
  expect(ref.spec).toMatch(/^file:/)
  // Must point at an absolute path that contains Cargo.toml + src + runtime/cli/index.ts.
  const dir = ref.spec.slice('file:'.length)
  expect(path.isAbsolute(dir)).toBe(true)
  expect(Bun.file(path.join(dir, 'Cargo.toml')).size).toBeGreaterThan(0)
  expect(Bun.file(path.join(dir, 'runtime/cli/index.ts')).size).toBeGreaterThan(0)
})

test('copyTemplate: strips .tmpl suffix and substitutes', async () => {
  const tmpl = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-src-'))
  const target = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-dst-'))
  try {
    await Bun.write(path.join(tmpl, 'a.txt'), 'static content\n')
    await Bun.write(path.join(tmpl, 'b.txt.tmpl'), 'name=__PROJECT_NAME__\n')
    await Bun.write(path.join(tmpl, '_gitignore'), 'node_modules/\n')

    await copyTemplate({
      templateDir: tmpl,
      targetDir: target,
      substitutions: { __PROJECT_NAME__: 'hello' },
    })

    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('static content\n')
    expect(await readFile(path.join(target, 'b.txt'), 'utf8')).toBe('name=hello\n')
    expect(await readFile(path.join(target, '.gitignore'), 'utf8')).toBe('node_modules/\n')
    const entries = await readdir(target)
    expect(entries).not.toContain('_gitignore')
    expect(entries).not.toContain('b.txt.tmpl')
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('copyTemplate: recurses into subdirectories', async () => {
  const tmpl = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-src-'))
  const target = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-dst-'))
  try {
    await Bun.write(path.join(tmpl, 'sub/nested.txt'), 'deep\n')
    await Bun.write(path.join(tmpl, 'sub/deep.tmpl'), 'X=__X__')

    await copyTemplate({
      templateDir: tmpl,
      targetDir: target,
      substitutions: { __X__: '42' },
    })

    expect(await readFile(path.join(target, 'sub/nested.txt'), 'utf8')).toBe('deep\n')
    expect(await readFile(path.join(target, 'sub/deep'), 'utf8')).toBe('X=42')
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('copyTemplate: throws if templateDir missing', async () => {
  await expect(copyTemplate({
    templateDir: '/no/such/dir',
    targetDir: '/tmp/whatever',
    substitutions: {},
  })).rejects.toThrow(/template directory/)
})
