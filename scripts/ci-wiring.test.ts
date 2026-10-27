// F438: every `tests/server/**/*.test.ts` file runs somewhere in CI. A lane's acceptance says "run the new served test alone"
// locally; nothing made it a CI step, so eight files on main were never run by CI (and one of them was red). This fails when a
// served test is named neither in `.github/workflows/ci.yml` nor in the root `server-test` script. A file that must stay out
// of CI goes in EXCLUDED with the reason; there is none today.
// F441: a ci.yml mention counts only on a real `run:` command line (single-line or a `run: |` block): a `#` comment or an
// `echo`/`printf` of the path does not make a test wired.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Glob } from 'bun'

const repo = resolve(import.meta.dir, '..')
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')
const serverTest: string = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts['server-test'] ?? ''

/** file (repo-relative) -> why CI does not run it. */
const EXCLUDED: Record<string, string> = {}

/** The shell command lines of every `run:` step in a workflow: comments dropped, block scalars expanded. */
export const runLines = (yaml: string): string[] => {
  const out: string[] = []
  let blockIndent = -1
  for (const raw of yaml.split('\n')) {
    const indent = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (blockIndent >= 0) {
      if (text === '' || indent > blockIndent) {
        if (text !== '' && !text.startsWith('#')) out.push(text.replace(/\s+#.*$/, ''))
        continue
      }
      blockIndent = -1
    }
    if (text.startsWith('#')) continue
    const m = /^(?:-\s+)?run:\s*(.*)$/.exec(text)
    if (!m) continue
    const rest = m[1]!.replace(/\s+#.*$/, '')
    if (/^[|>][+-]?$/.test(rest)) blockIndent = indent
    else if (rest) out.push(rest)
  }
  return out
}

/** True when some run line other than an echo/printf names `file`. */
export const wiredIn = (yaml: string, file: string): boolean =>
  runLines(yaml).some((l) => l.includes(file) && !/^(?:echo|printf)\b/.test(l))

const served = [...new Glob('tests/server/**/*.test.ts').scanSync({ cwd: repo })].sort()
const wired = (file: string): boolean => wiredIn(ci, file) || serverTest.includes(file)

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

const F = 'tests/server/x.test.ts'
const step = (body: string) => `jobs:\n  t:\n    steps:\n${body}\n`

test('a commented-out step is not wired', () => {
  expect(wiredIn(step(`      # - run: bun test ${F}`), F)).toBe(false)
  expect(wiredIn(step(`      - run: bun test other.test.ts # ${F}`), F)).toBe(false)
})

test('an echo of the path is not wired', () => {
  expect(wiredIn(step(`      - run: echo "${F}"`), F)).toBe(false)
  expect(wiredIn(step(`      - name: ${F}\n        run: echo ${F}`), F)).toBe(false)
})

test('a real run line is wired', () => {
  expect(wiredIn(step(`      - run: bun test --timeout 1 ${F}`), F)).toBe(true)
  expect(wiredIn(step(`      - name: n\n        run: bun test ${F}`), F)).toBe(true)
})

test('a multi-line run block is wired, a comment inside it is not', () => {
  const block = `      - run: |\n          echo start\n          # bun test ${F}\n          bun test other.test.ts\n      - name: after`
  expect(wiredIn(step(block), F)).toBe(false)
  expect(wiredIn(step(`      - run: |\n          echo start\n          bun test ${F}\n      - name: after`), F)).toBe(true)
  expect(wiredIn(step(`      - run: |\n          echo start\n      - name: ${F}`), F)).toBe(false)
})
