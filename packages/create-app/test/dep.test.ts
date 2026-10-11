import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyOverrides, monorepoRoot, PLATS, resolveBrustDep } from '../src/dep.ts'

const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })
const write = (p: string, v: unknown) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }

/** A fake monorepo: <root>/packages/create-app is the package root. */
function fakeRepo(rootName = 'brust-v2') {
  const root = mkdtempSync(join(tmpdir(), 'ca-dep-')); made.push(root)
  write(join(root, 'package.json'), { name: rootName, workspaces: ['packages/*', 'examples/*'] })
  write(join(root, 'packages/brust/package.json'), { name: '@brust/core' })
  write(join(root, 'examples/pokedex/routes.tsx'), '')
  write(join(root, 'packages/create-app/package.json'), { version: '1.2.3-alpha.4' })
  return { root, pkgRoot: join(root, 'packages/create-app') }
}

test('explicit --brust-dep wins verbatim, no overrides', () => {
  const { root, pkgRoot } = fakeRepo()
  expect(resolveBrustDep({ explicit: 'file:/x.tgz', targetDir: join(root, 'other'), pkgRoot })).toEqual({ kind: 'explicit', spec: 'file:/x.tgz' })
})

test('published (no monorepo markers) → ^<own version>', () => {
  const root = mkdtempSync(join(tmpdir(), 'ca-pub-')); made.push(root)
  const pkgRoot = join(root, 'node_modules/@brust/create-app')
  write(join(pkgRoot, 'package.json'), { version: '0.3.0-alpha.1' })
  expect(resolveBrustDep({ targetDir: join(root, 'app'), pkgRoot })).toEqual({ kind: 'version', spec: '^0.3.0-alpha.1' })
})

test('monorepo + target under a workspace glob (examples/demo) → workspace:*', () => {
  const { root, pkgRoot } = fakeRepo()
  expect(resolveBrustDep({ targetDir: join(root, 'examples/demo'), pkgRoot })).toEqual({ kind: 'workspace', spec: 'workspace:*' })
})

test('monorepo + target outside → file:<root>/packages/brust + overrides for runtime-dom and the six natives', () => {
  const { root, pkgRoot } = fakeRepo()
  const d = resolveBrustDep({ targetDir: join(tmpdir(), 'elsewhere-app'), pkgRoot })
  expect(d.kind).toBe('file')
  expect(d.spec).toBe(`file:${root}/packages/brust`)
  expect(Object.keys(d.overrides!).sort()).toEqual(['@brust/runtime-dom', ...PLATS.map((p) => `@brust/native-${p}`)].sort())
  expect(d.overrides!['@brust/runtime-dom']).toBe(`file:${root}/packages/runtime-dom`)
  expect(d.overrides!['@brust/native-darwin-arm64']).toBe(`file:${root}/npm/darwin-arm64`)
})

test('a root package.json with another name is not a monorepo', () => {
  const { root, pkgRoot } = fakeRepo('something-else')
  expect(monorepoRoot(pkgRoot)).toBeNull()
  expect(resolveBrustDep({ targetDir: join(root, 'x'), pkgRoot }).kind).toBe('version')
})

test('the real repo is detected from packages/create-app', () => {
  expect(monorepoRoot()).toBe(resolve(import.meta.dir, '../../..'))
})

test('applyOverrides merges into package.json and keeps 2-space JSON + trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-ov-')); made.push(dir)
  write(join(dir, 'package.json'), '{\n  "name": "a",\n  "overrides": { "keep": "1" }\n}\n')
  applyOverrides(dir, { '@brust/runtime-dom': 'file:/rd' })
  const raw = readFileSync(join(dir, 'package.json'), 'utf8')
  expect(JSON.parse(raw).overrides).toEqual({ keep: '1', '@brust/runtime-dom': 'file:/rd' })
  expect(raw.endsWith('}\n')).toBe(true)
  expect(raw).toContain('\n  "name": "a"')
})
