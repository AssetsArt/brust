import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dir, '../bin/create-app.ts')
const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })
const work = () => { const d = mkdtempSync(join(tmpdir(), 'ca-cli-')); made.push(d); return d }
function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bun', BIN, ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const walk = (d: string, base = d): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)]))

test('missing name → exit 1', () => {
  const r = run([], work())
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/missing project name/)
})
test('invalid name → exit 1', () => expect(run(['Bad_Name'], work()).code).toBe(1))
test('non-empty target dir → exit 1', () => {
  const w = work(); mkdirSync(join(w, 'app')); writeFileSync(join(w, 'app/x'), '1')
  const r = run(['app', '--brust-dep', 'file:/x', '--yes'], w)
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/not empty/)
})
test('--help → usage on stdout, exit 0', () => {
  const r = run(['--help'], work())
  expect(r.code).toBe(0)
  expect(r.out).toContain('usage: bun create @brust/app')
})
test('blank scaffold emits the tree with no .tmpl, no _gitignore, no placeholder leaks; package.json name + @brust/core', () => {
  const w = work()
  const r = run(['demo', '--yes', '--brust-dep', 'file:/x'], w)
  expect(r.code).toBe(0)
  const files = walk(join(w, 'demo'))
  expect(files.some((f) => f.endsWith('.tmpl') || f.includes('_gitignore'))).toBe(false)
  expect(files).toContain('.gitignore')
  // the build output and the compiler's cache never get committed (L28 review N3)
  const ignored = readFileSync(join(w, 'demo/.gitignore'), 'utf8').split('\n')
  for (const e of ['dist/', '.brust/', 'node_modules/']) expect([e, ignored.includes(e)]).toEqual([e, true])
  for (const f of files) expect(readFileSync(join(w, 'demo', f), 'utf8')).not.toMatch(/__PROJECT_NAME__|__BRUST_DEP__/)
  const pkg = JSON.parse(readFileSync(join(w, 'demo/package.json'), 'utf8'))
  expect([pkg.name, pkg.dependencies['@brust/core'], pkg.overrides]).toEqual(['demo', 'file:/x', undefined])
})
test('an empty existing target dir is accepted', () => {
  const w = work(); mkdirSync(join(w, 'app'))
  expect(run(['app', '--yes', '--brust-dep', 'file:/x'], w).code).toBe(0)
  expect(existsSync(join(w, 'app/package.json'))).toBe(true)
})
test('a failed copy removes a target it created (rollback)', () => {
  const w = work()
  const r = run(['app', '--yes', '--brust-dep', 'file:/x'], w, { CREATE_APP_TEMPLATES_DIR: join(w, 'missing-templates') })
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/failed to scaffold/)
  expect(existsSync(join(w, 'app'))).toBe(false)
})
test('next steps print cd ./<rel>, bun install, bun run dev', () => {
  const w = work()
  const r = run(['app', '--yes', '--brust-dep', 'file:/x'], w)
  expect(r.out).toContain('Next:')
  expect(r.out).toMatch(/cd (\.\/app|\/.*\/app)/)
  expect(r.out).toContain('bun install')
  expect(r.out).toContain('bun run dev')
})
test('monorepo mode without --brust-dep re-syncs pokedex then writes file: + overrides', () => {
  const w = work()
  const gen = join(import.meta.dir, '../templates/pokedex')
  rmSync(gen, { recursive: true, force: true })
  const r = run(['app', '--template', 'pokedex', '--yes'], w)
  expect(r.code).toBe(0)
  expect(existsSync(join(gen, 'routes.tsx'))).toBe(true)
  const pkg = JSON.parse(readFileSync(join(w, 'app/package.json'), 'utf8'))
  expect(pkg.dependencies['@brust/core']).toMatch(/^file:.*\/packages\/brust$/)
  expect(Object.keys(pkg.overrides)).toHaveLength(8)
  expect(pkg.overrides['@brust/runtime-dom']).toMatch(/\/packages\/runtime-dom$/)
  expect(existsSync(join(w, 'app/data/pokedex.json'))).toBe(true)
  expect(existsSync(join(w, 'app/data/team.sqlite'))).toBe(false)
})
