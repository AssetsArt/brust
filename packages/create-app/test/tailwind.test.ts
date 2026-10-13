// `--tailwind` (L21) became a no-op in L28 (R29.1): the blank template itself uses Tailwind CSS v4. The flag is still
// accepted, prints one line, and scaffolds exactly what the plain command does. The installed, built and served app is
// scaffold.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAILWIND_DEFAULT_NOTE } from '../src/tailwind.ts'

const BIN = join(import.meta.dir, '../bin/create-app.ts')
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const walk = (d: string, base = d): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)]))
const tree = (d: string) => Object.fromEntries(walk(d).sort().map((f) => [f, readFileSync(join(d, f), 'utf8')]))
function scaffold(extra: string[]) {
  const w = mkdtempSync(join(tmpdir(), 'ca-tw-'))
  made.push(w)
  const r = Bun.spawnSync(['bun', BIN, 'app', '--template', 'blank', '--yes', '--brust-dep', 'file:/x', ...extra], { cwd: w, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), tree: tree(join(w, 'app')) }
}

test('--tailwind is accepted, prints that Tailwind is the default, and scaffolds the same tree as without it', () => {
  const plain = scaffold([])
  const flagged = scaffold(['--tailwind'])
  expect([plain.code, flagged.code]).toEqual([0, 0])
  expect(flagged.out).toContain(TAILWIND_DEFAULT_NOTE)
  expect(plain.out).not.toContain(TAILWIND_DEFAULT_NOTE)
  expect(flagged.out).toContain('(template: blank, @brust/core file:/x)')
  expect(flagged.tree).toEqual(plain.tree)
  expect(Object.keys(plain.tree)).toContain('app.css')
  expect(plain.tree['app.css']).toStartWith('@import "tailwindcss";\n')
})
