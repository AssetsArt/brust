import { afterEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { syncTemplate } from '../scripts/sync-template.ts'

const repo = join(import.meta.dir, '../../..')
const FROM = join(repo, 'examples/pokedex')
const OVERLAY = join(import.meta.dir, '../template-overlays/pokedex')
const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ca-sync-')); made.push(d); return d }
const walk = (d: string, skipNm = true): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (skipNm && e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(d, e.name), skipNm).map((x) => `${e.name}/${x}`) : [e.name]))
const EXCLUDED_TOP = new Set(['dist', 'test', 'README.md', 'package.json', '.gitignore', '.wrangler'])
const blankWrangler = JSON.parse(readFileSync(join(import.meta.dir, '../templates/blank/package.json.tmpl'), 'utf8').replace('__BRUST_DEP__', '"x"')).devDependencies.wrangler as string

test('every kept file is byte-equal to its source; excluded paths absent (R4 list)', () => {
  const to = join(tmp(), 'out')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  const src = walk(FROM).filter((f) => !EXCLUDED_TOP.has(f.split('/')[0]!) && !/^dist-/.test(f) && !/(^|\/)(\.DS_Store)$|\.tsbuildinfo$|^data\/team\.sqlite|(^|\/)\.dev\.vars|\.sqlite(-wal|-shm)?$/.test(f))
  const out = walk(to).filter((f) => !['package.json.tmpl', '_gitignore', 'README.md.tmpl'].includes(f))
  expect(out.sort()).toEqual(src.sort())
  for (const f of src) expect(readFileSync(join(to, f)).equals(readFileSync(join(FROM, f))), f).toBe(true)
  expect(existsSync(join(to, 'test'))).toBe(false)
  expect(existsSync(join(to, 'node_modules'))).toBe(false)
})

test('package.json.tmpl: name/version/private, @brust/core = __BRUST_DEP__ unquoted, test script dropped, dev present, other deps verbatim', () => {
  const to = join(tmp(), 'out')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  const raw = readFileSync(join(to, 'package.json.tmpl'), 'utf8')
  expect(raw).toContain('"@brust/core": __BRUST_DEP__')
  const pkg = JSON.parse(raw.replace('__BRUST_DEP__', '"^1.0.0"'))
  const src = JSON.parse(readFileSync(join(FROM, 'package.json'), 'utf8'))
  expect([pkg.name, pkg.version, pkg.private]).toEqual(['__PROJECT_NAME__', '0.0.1', true])
  expect(pkg.scripts.test).toBeUndefined()
  expect(pkg.scripts.dev).toBe('brust dev routes.tsx')
  expect(pkg.scripts.build).toBe(src.scripts.build)
  expect(pkg.dependencies).toEqual({ ...src.dependencies, '@brust/core': '^1.0.0' })
  expect(pkg.devDependencies).toEqual({ ...src.devDependencies, wrangler: blankWrangler })
  for (const k of ['dev:cf', 'deploy:cf', 'cf:migrate:local', 'cf:migrate:remote']) expect(pkg.scripts[k], k).toBe(src.scripts[k])
})

test('_gitignore = node_modules/, dist/ + examples/pokedex/.gitignore lines, deduped', () => {
  const to = join(tmp(), 'out')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  const lines = readFileSync(join(to, '_gitignore'), 'utf8').trim().split('\n')
  expect(lines.slice(0, 2)).toEqual(['node_modules/', 'dist/'])
  for (const l of readFileSync(join(FROM, '.gitignore'), 'utf8').trim().split('\n')) expect(lines).toContain(l)
  expect(new Set(lines).size).toBe(lines.length)
})

test('README.md.tmpl comes from the overlay and contains __PROJECT_NAME__', () => {
  const to = join(tmp(), 'out')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  const readme = readFileSync(join(to, 'README.md.tmpl'), 'utf8')
  expect(readme).toBe(readFileSync(join(OVERLAY, 'README.md.tmpl'), 'utf8'))
  expect(readme).toContain('__PROJECT_NAME__')
})

test('re-sync removes a stale file in the output', () => {
  const to = join(tmp(), 'out')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  writeFileSync(join(to, 'stale.txt'), 'x')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  expect(existsSync(join(to, 'stale.txt'))).toBe(false)
})

test('throws when the source dependency is not workspace:*', () => {
  const w = tmp(); const from = join(w, 'src')
  cpSync(FROM, from, { recursive: true, filter: (s) => !s.includes('node_modules') })
  const p = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')); p.dependencies['@brust/core'] = '^1'
  writeFileSync(join(from, 'package.json'), JSON.stringify(p))
  expect(() => syncTemplate({ from, to: join(w, 'out'), overlay: OVERLAY })).toThrow(/must depend on @brust\/core workspace:\*/)
})

test('examples/pokedex is unchanged by a sync', () => {
  const before = Bun.spawnSync(['git', 'status', '--porcelain', 'examples/pokedex'], { cwd: repo }).stdout.toString()
  syncTemplate({ from: FROM, to: join(tmp(), 'out'), overlay: OVERLAY })
  expect(Bun.spawnSync(['git', 'status', '--porcelain', 'examples/pokedex'], { cwd: repo }).stdout.toString()).toBe(before)
  expect(relative(repo, FROM)).toBe('examples/pokedex')
})

test('local Cloudflare state never reaches the template; the D1 files do', () => {
  const from = join(tmp(), 'from')
  cpSync(FROM, from, { recursive: true, filter: (s) => !/node_modules/.test(s) })
  mkdirSync(join(from, '.wrangler/state/v3/d1'), { recursive: true })
  writeFileSync(join(from, '.wrangler/state/v3/d1/x.sqlite'), 'x')
  writeFileSync(join(from, '.dev.vars'), 'SECRET=1')
  writeFileSync(join(from, '.dev.vars.local'), 'SECRET=1')
  writeFileSync(join(from, 'data/team.sqlite-wal'), 'x')
  writeFileSync(join(from, 'data/other.sqlite-shm'), 'x')
  const to = join(tmp(), 'out')
  syncTemplate({ from, to, overlay: OVERLAY })
  const out = walk(to)
  expect(out.filter((f) => /(^|\/)\.wrangler\//.test(f) || /(^|\/)\.dev\.vars/.test(f) || /\.sqlite(-wal|-shm)?$/.test(f))).toEqual([])
  expect(out).toContain('lib/team-db.sqlite.ts')
  expect(out).toContain('migrations/0001_team.sql')
  expect(out).toContain('wrangler.jsonc')
})

test('global CSS: the scaffold has app.css at the root, imported by the layout and the 404; no prebuilt public/app.css or styles/; the Tailwind pins equal blank', () => {
  const to = join(tmp(), 'out')
  syncTemplate({ from: FROM, to, overlay: OVERLAY })
  expect(existsSync(join(to, 'app.css'))).toBe(true)
  expect(existsSync(join(to, 'public/app.css'))).toBe(false)
  expect(existsSync(join(to, 'styles'))).toBe(false)
  expect(readFileSync(join(to, 'app.css'), 'utf8')).toMatch(/^@import "tailwindcss";/)
  for (const f of ['components/AppLayout.tsx', 'pages/NotFoundPage.tsx']) {
    const text = readFileSync(join(to, f), 'utf8')
    expect([f, text.includes("import '../app.css'")]).toEqual([f, true])
    expect([f, text.includes('rel="stylesheet"')]).toEqual([f, false])
  }
  const pkg = JSON.parse(readFileSync(join(to, 'package.json.tmpl'), 'utf8').replace('__BRUST_DEP__', '"x"'))
  const blank = JSON.parse(readFileSync(join(import.meta.dir, '../templates/blank/package.json.tmpl'), 'utf8').replace('__BRUST_DEP__', '"x"'))
  for (const k of ['tailwindcss', '@tailwindcss/node', '@tailwindcss/oxide']) expect([k, pkg.devDependencies[k]]).toEqual([k, blank.devDependencies[k]])
  const readme = readFileSync(join(to, 'README.md.tmpl'), 'utf8')
  expect(readme).not.toContain('public/app.css')
  expect(readme).not.toContain('@tailwindcss/cli')
})
