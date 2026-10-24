// F438: every `tests/server/**/*.test.ts` file runs somewhere in CI. A lane's acceptance says "run the new served test alone"
// locally; nothing made it a CI step, so eight files on main were never run by CI (and one of them was red). This fails when a
// served test is named neither in `.github/workflows/ci.yml` nor in the root `server-test` script. A file that must stay out
// of CI goes in EXCLUDED with the reason; there is none today.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Glob } from 'bun'

const repo = resolve(import.meta.dir, '..')
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')
const serverTest: string = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts['server-test'] ?? ''

/** file (repo-relative) -> why CI does not run it. */
const EXCLUDED: Record<string, string> = {}

const served = [...new Glob('tests/server/**/*.test.ts').scanSync({ cwd: repo })].sort()
const wired = (file: string): boolean => ci.includes(file) || serverTest.includes(file)

test('there are served tests to check', () => {
  expect(served.length).toBeGreaterThan(50)
})

test('every served test file is a CI step or in the server-test script', () => {
  const missing = served.filter((f) => !wired(f) && !(f in EXCLUDED))
  expect(missing).toEqual([])
})

test('an exclusion names a real file, says why, and is not wired after all', () => {
  for (const [file, why] of Object.entries(EXCLUDED)) {
    expect(existsSync(join(repo, file))).toBe(true)
    expect(why.trim().length).toBeGreaterThan(10)
    expect(wired(file)).toBe(false)
  }
})

test('ci.yml names no served test that does not exist', () => {
  const named = [...ci.matchAll(/tests\/server\/[\w./-]+\.test\.ts/g)].map((m) => m[0])
  expect(named.filter((f) => !existsSync(join(repo, f)))).toEqual([])
})
