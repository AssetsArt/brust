// The published shape: `bun pm pack` (prepack generates templates/pokedex) and a look inside the tarball.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = join(import.meta.dir, '..')
let work = ''
let tgz = ''
let names: string[] = []
let verbose = ''
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ca-pack-'))
  const p = Bun.spawnSync(['bun', 'pm', 'pack', '--destination', work], { cwd: PKG, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`bun pm pack failed:\n${p.stdout.toString()}${p.stderr.toString()}`)
  tgz = Bun.spawnSync(['sh', '-c', `ls ${work}/*.tgz`]).stdout.toString().trim()
  names = Bun.spawnSync(['tar', '-tzf', tgz]).stdout.toString().trim().split('\n')
  verbose = Bun.spawnSync(['tar', '-tvzf', tgz]).stdout.toString()
}, 300_000)
afterAll(() => rmSync(work, { recursive: true, force: true }))

test('prepack generated templates/pokedex and it ships', () => {
  for (const f of ['routes.tsx', 'package.json.tmpl', '_gitignore', 'data/pokedex.json', 'actions.ts', 'README.md.tmpl']) expect(names, f).toContain(`package/templates/pokedex/${f}`)
  expect(names).toContain('package/templates/blank/_gitignore')
  expect(names).toContain('package/templates/blank/package.json.tmpl')
})
test('no node_modules/, dist/, test/, team.sqlite, .gitignore or .npmrc anywhere in the tarball', () => {
  expect(names.filter((n) => /\/(node_modules|dist|test)\//.test(n) || /team\.sqlite/.test(n) || /(^|\/)\.(gitignore|npmrc)$/.test(n) || /(^|\/)\.wrangler\//.test(n) || /\.dev\.vars/.test(n) || /\.sqlite(-wal|-shm)?$/.test(n))).toEqual([])
})
test('packed package.json: bin create-app, no workspace:, no dependencies', () => {
  const pj = JSON.parse(Bun.spawnSync(['tar', '-xzOf', tgz, 'package/package.json']).stdout.toString())
  expect(pj.name).toBe('@brust/create-app')
  expect(pj.bin).toEqual({ 'create-app': './bin/create-app.ts' })
  expect(pj.dependencies).toBeUndefined()
  expect(JSON.stringify(pj)).not.toContain('workspace:')
})
test('bin is executable in the tarball', () => {
  expect(verbose.split('\n').find((l) => l.endsWith('package/bin/create-app.ts'))).toMatch(/^-rwx/)
})
