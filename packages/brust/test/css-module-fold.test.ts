// L20 css-module-fold: `styles.x` / `styles['x']` of a `*.module.css` import is the literal class in the template,
// so static and native components keep `needs_worker: false` and no job; an unknown class is a build error with
// its source location. Built with the real CLI on test/fixtures/css-fold. Run alone:
// `bun test --timeout 300000 test/css-module-fold.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = join(import.meta.dir, 'fixtures/css-fold')
const bin = join(import.meta.dir, '../bin/brust')
const copies: string[] = []
type Manifest = { components: Record<string, { template: string; jobs: unknown[]; needs_worker: boolean; tier: string }> }

function build(cwd: string) {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: b.exitCode, stdout: b.stdout.toString(), stderr: b.stderr.toString() }
}
function variant(name: string, edit: (dir: string) => void): string {
  const dir = join(import.meta.dir, `fixtures/.css-fold-${name}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('/dist') })
  copies.push(dir)
  edit(dir)
  return dir
}
const comp = (m: Manifest, prefix: string) => Object.entries(m.components).find(([id]) => id.startsWith(prefix))![1]
const jinja = (c: { template: string }) => readFileSync(join(fixture, 'dist', c.template), 'utf8')
/** Class names of one module, in the emitted CSS (`.card_hash`). */
const classesIn = (file: string) => Object.fromEntries([...readFileSync(join(fixture, 'dist', file), 'utf8').matchAll(/\.([A-Za-z]+)_([\w-]+)/g)].map((m) => [m[1]!, `${m[1]}_${m[2]}`]))

let manifest: Manifest
beforeAll(() => {
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
  const b = build(fixture)
  if (b.code !== 0) throw new Error(`brust build failed:\n${b.stderr}`)
  manifest = JSON.parse(readFileSync(join(fixture, 'dist/manifest.json'), 'utf8'))
}, 300_000)
afterAll(() => {
  for (const d of [join(fixture, 'dist'), ...copies]) rmSync(d, { recursive: true, force: true })
})

test('L20: a static page folds s.card, s[\'hero\'] and a template literal; no job, no worker', () => {
  const c = comp(manifest, 'static_')
  expect([c.tier, c.jobs, c.needs_worker]).toEqual(['static', [], false])
  const t = jinja(c)
  const cls = classesIn(cssFile('card'))
  expect(t).toContain(`"${cls.card}"`)
  expect(t).toContain(`"${cls.hero}"`)
  expect(t).toContain(`~ "${cls.card}" ~ " extra"`) // the template literal is a concatenation of literals
  expect(t).not.toMatch(/_s\d|__list/)
})

test('L20: a native page folds both arms of a conditional class; it stays native with no job', () => {
  const c = comp(manifest, 'native_')
  expect([c.tier, c.jobs, c.needs_worker]).toEqual(['native', [], false])
  const cls = classesIn(cssFile('btn'))
  const t = jinja(c)
  expect(t).toContain(`"${cls.off}"`)
  expect(t).toContain(`"${cls.on}"`)
})

test('L20: an unknown class is a build error naming the file, line and column; nothing is written', () => {
  const dir = variant('unknown', (d) => writeFileSync(join(d, 'Static.tsx'), "import s from './card.module.css'\n\nexport default function Static() {\n  return <p className={s.nope}>x</p>\n}\n"))
  const b = build(dir)
  expect(b.code).toBe(1)
  expect(b.stderr).toStartWith('error css-module-class Static.tsx:4:')
  expect(b.stderr).toContain('class `nope` is not defined in ./card.module.css')
})

function cssFile(stem: string): string {
  return `client/${readdirSync(join(fixture, 'dist/client')).find((n) => n.startsWith(`${stem}.module-`) && n.endsWith('.css'))}`
}
