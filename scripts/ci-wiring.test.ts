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

// F489: the Windows jobs run the packages/brust and create-app test files that pass there; the rest are skipped on purpose,
// each named in a `# windows-skip: <repo path> <reason>` comment inside a windows job. A test file in neither list fails here,
// so a new file cannot silently stay Linux-only.
const PKGS = ['packages/brust', 'packages/create-app']

/** The `jobs.<name>` blocks of ci.yml whose name starts with `windows`, as raw text. */
export const windowsJobs = (yaml: string): string => {
  const out: string[] = []
  let on = false
  for (const line of yaml.split('\n')) {
    const job = /^  ([\w-]+):\s*$/.exec(line)
    if (job) on = job[1]!.startsWith('windows')
    else if (/^\S/.test(line)) on = false
    if (on) out.push(line)
  }
  return out.join('\n')
}

/** True when a run line of `jobs` names `file` (repo path under one of PKGS), by full path or as `test/x` after `cd <pkg>`
 * (also as a word of a `for f in ...; do` list). */
export const windowsWired = (jobs: string, file: string): boolean => {
  const pkg = PKGS.find((p) => file.startsWith(`${p}/`))
  if (!pkg) return false
  const rel = file.slice(pkg.length + 1)
  const relRe = new RegExp(`(^|\\s)${rel.replaceAll('.', '\\.')}(\\s|;|$)`)
  return runLines(jobs).some(
    (l) => !/^(?:echo|printf)\b/.test(l) && (l.includes(file) || (new RegExp(`\\bcd ${pkg}(\\s|&|;|$)`).test(l) && relRe.test(l))),
  )
}

/** `# windows-skip: <path> <reason>` comments in `jobs`: path -> reason. */
export const windowsSkips = (jobs: string): Map<string, string> =>
  new Map([...jobs.matchAll(/^\s*# windows-skip: (\S+)\s+(.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]))

const winJobs = windowsJobs(ci)
const unitFiles = PKGS.flatMap((p) => [...new Glob(`${p}/test/*.test.ts`).scanSync({ cwd: repo })]).sort()

test('there are Windows jobs and package test files to check', () => {
  expect(winJobs).toContain('runs-on: windows-latest')
  expect(unitFiles.length).toBeGreaterThan(90)
})

test('every packages/brust and create-app test file runs on Windows or is a windows-skip with a reason', () => {
  const skips = windowsSkips(winJobs)
  expect(unitFiles.filter((f) => !windowsWired(winJobs, f) && !skips.has(f))).toEqual([])
})

test('a windows-skip names a real test file, says why, and is not run on Windows after all', () => {
  for (const [file, why] of windowsSkips(winJobs)) {
    expect({ file, exists: existsSync(join(repo, file)) }).toEqual({ file, exists: true })
    expect({ file, why: why.length > 10 }).toEqual({ file, why: true })
    expect({ file, wired: windowsWired(winJobs, file) }).toEqual({ file, wired: false })
  }
})

const winStep = (body: string) => `jobs:\n  windows:\n    runs-on: windows-latest\n    steps:\n${body}\n  website:\n    steps:\n      - run: cd packages/brust && bun test test/z.test.ts\n`

test('windows wiring: by cd + relative path, by full path, not across packages, not from another job', () => {
  const y = winStep('      - run: cd packages/brust && bun test test/a.test.ts test/b.test.ts\n      - run: bun test packages/create-app/test/dep.test.ts')
  const j = windowsJobs(y)
  expect(windowsWired(j, 'packages/brust/test/a.test.ts')).toBe(true)
  expect(windowsWired(j, 'packages/brust/test/b.test.ts')).toBe(true)
  expect(windowsWired(j, 'packages/create-app/test/dep.test.ts')).toBe(true)
  expect(windowsWired(j, 'packages/create-app/test/a.test.ts')).toBe(false)
  expect(windowsWired(j, 'packages/brust/test/z.test.ts')).toBe(false)
  expect(windowsWired(j, 'packages/brust/test/a.test.tsx')).toBe(false)
  const loop = windowsJobs(winStep('      - run: cd packages/brust && for f in test/c.test.ts test/d.test.ts; do bun test "$f" || exit 1; done'))
  expect(windowsWired(loop, 'packages/brust/test/c.test.ts')).toBe(true)
  expect(windowsWired(loop, 'packages/brust/test/d.test.ts')).toBe(true)
})

test('windows wiring: a comment is not a run, a windows-skip comment is read with its reason', () => {
  const j = windowsJobs(winStep('      # - run: cd packages/brust && bun test test/a.test.ts\n      # windows-skip: packages/brust/test/a.test.ts (d) needs redis'))
  expect(windowsWired(j, 'packages/brust/test/a.test.ts')).toBe(false)
  expect([...windowsSkips(j)]).toEqual([['packages/brust/test/a.test.ts', '(d) needs redis']])
})
