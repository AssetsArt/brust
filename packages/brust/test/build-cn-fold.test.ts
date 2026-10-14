// F149 (plan 2026-10-14-shadcn-cn-fold, R34.88-R34.93): an inlined instance whose child job reads only constants
// and allowed code runs that job once at `brust build`; the page prints the result and the instance record (the
// per-request job call) is gone. Stand-in packages (no network): `cva` reads the host environment for `variant="boom"`
// (fails at build only), `radix-ui` reads
// the host environment when loaded (the evaluator forbids it), `tones` is off the allowlist.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installPackages } from './fixtures/cn-fold/install'

const root = join(import.meta.dir, 'fixtures/cn-fold')
const app = join(root, 'app')
const bin = join(import.meta.dir, '../bin/brust')
let uninstall: () => void

type Manifest = {
  routes: { chain: string[] }[]
  components: Record<string, { jobs: { kind: string }[]; children: { id: string; instances: string; literals?: Record<string, unknown> }[]; template: string }>
}
const build = (env: Record<string, string> = {}, out = 'dist') =>
  Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: app, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
const manifest = (out = 'dist') => JSON.parse(readFileSync(join(app, out, 'manifest.json'), 'utf8')) as Manifest
const page = (m: Manifest) => m.components[m.routes[0]!.chain.at(-1)!]!
const short = (id: string) => id.replace(/_[0-9a-f]+$/, '')

let built: ReturnType<typeof build>
beforeAll(() => {
  uninstall = installPackages(root)
  built = build()
}, 120_000)
afterAll(() => {
  for (const d of ['dist', 'dist-ref']) rmSync(join(app, d), { recursive: true, force: true })
  uninstall?.()
})

test('the app builds', () => {
  expect(built.exitCode, built.stderr.toString()).toBe(0)
})

test('constant-input instances of allowed jobs are evaluated: their records are gone, their classes printed', () => {
  const m = manifest()
  const kept = page(m).children.map((c) => `${short(c.id)} ${JSON.stringify(c.literals ?? {})}`)
  // Left: the instance whose evaluation threw, and the one whose job imports a package off the allowlist.
  expect(kept.sort()).toEqual(['badge {"variant":"boom"}', 'chip {}'])
  const jinja = readFileSync(join(app, 'dist', page(m).template), 'utf8')
  expect(jinja).toContain('"inline-flex rounded-full bg-secondary"')
  expect(jinja).toContain('"inline-flex rounded-full bg-primary"')
  // Rule 3: `buttonVariants` from ./button, re-emitted folded; ./button and radix-ui were never loaded at build.
  expect(jinja).toContain('"inline-flex size-9"')
})

test('a failing evaluation is a warning with its location; the instance keeps its job', () => {
  const log = built.stderr.toString() + built.stdout.toString()
  expect(log).toMatch(/warning build-eval Page\.tsx:\d+:\d+ <badge_[0-9a-f]+> not evaluated at build, its job stays: build-eval: process\.env is not allowed/)
  expect(log).not.toMatch(/could not (start|be bundled)/)
})

test('the served page equals the per-request job path (R34.93 dual run, BRUST_BUILD_EVAL=0)', async () => {
  const ref = build({ BRUST_BUILD_EVAL: '0' }, 'dist-ref')
  expect(ref.exitCode, ref.stderr.toString()).toBe(0)
  expect(page(manifest('dist-ref')).children).toHaveLength(5) // reference: every instance keeps its job
  const serve = async (dist: string) => {
    const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist], { cwd: app, env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }, stdout: 'pipe', stderr: 'inherit' })
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let out = ''
    while (!/\[brust\] ready/.test(out)) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`brust start exited before ready:\n${out}`)
      out += dec.decode(value, { stream: true })
    }
    void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
    return { base: `http://${/listening on (\S+)/.exec(out)![1]}`, stop: async () => { proc.kill('SIGINT'); await Promise.race([proc.exited, Bun.sleep(5000)]); proc.kill('SIGKILL') } }
  }
  const [a, b] = [await serve('dist'), await serve('dist-ref')]
  try {
    const get = async (s: { base: string }) => (await fetch(`${s.base}/`)).text()
    const [folded, job] = [await get(a), await get(b)]
    expect(folded).toContain('class="inline-flex size-9"')
    expect(folded).toBe(job)
  } finally {
    await a.stop()
    await b.stop()
  }
}, 120_000)
