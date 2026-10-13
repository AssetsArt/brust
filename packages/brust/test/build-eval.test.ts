// L2 (gap-build-eval): pure helper calls and `buildTime(…)` are evaluated once at `brust build`.
// Builds real apps with the CLI (a tiny local package stands in for shiki: no network).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installTinyFmt } from './fixtures/build-eval/install'

const root = join(import.meta.dir, 'fixtures/build-eval')
const bin = join(import.meta.dir, '../bin/brust')
const ok = join(root, 'ok')
let uninstall: () => void

const build = (cwd: string, env: Record<string, string> = {}, out = 'dist') =>
  Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
const manifest = (cwd: string, out = 'dist') => JSON.parse(readFileSync(join(cwd, out, 'manifest.json'), 'utf8')) as { components: Record<string, { tier: string; needs_worker: boolean; jobs: { kind: string }[] }> }
const comp = (m: ReturnType<typeof manifest>, prefix: string) => Object.entries(m.components).find(([id]) => id.startsWith(prefix))![1]
const jinja = (cwd: string, prefix: string, out = 'dist') => {
  const id = Object.keys(manifest(cwd, out).components).find((i) => i.startsWith(prefix))!
  return readFileSync(join(cwd, out, 'jinja', `${id}.jinja`), 'utf8')
}

let okBuild: ReturnType<typeof build>
beforeAll(() => {
  uninstall = installTinyFmt(root)
  okBuild = build(ok)
}, 120_000)
afterAll(() => {
  for (const app of ['ok', 'throws', 'client', 'envbt', 'importmeta-bt']) rmSync(join(root, app, 'dist'), { recursive: true, force: true })
  rmSync(join(ok, 'dist-ref'), { recursive: true, force: true })
  uninstall?.()
})

test('the app builds', () => {
  expect(okBuild.exitCode, okBuild.stderr.toString()).toBe(0)
})

test('a pure helper called with constants is baked: no job, no worker', () => {
  const m = manifest(ok)
  const pure = comp(m, 'pure_')
  expect(pure.jobs).toEqual([])
  expect(pure.needs_worker).toBe(false)
  const html = jinja(ok, 'pure_')
  expect(html).toContain('"3.14"')           // fmt(3.14159) from the same file
  expect(html).toContain('"hello-world"')    // slugify('Hello World') from a relatively imported file
  expect(html).not.toContain('_s1')
})

test('an impure helper keeps its job; the runtime guard names why (warning build-eval, with a location)', () => {
  expect(comp(manifest(ok), 'impure_').jobs.map((j) => j.kind)).toEqual(['precompute'])
  const err = okBuild.stderr.toString() + okBuild.stdout.toString()
  expect(err).toMatch(/warning build-eval Impure\.tsx:\d+:\d+ .*Math\.random\(\) is not allowed/)
})

test('relatively imported helpers are read, not assumed: process.env, module state and node:fs stay jobs', () => {
  const c = comp(manifest(ok), 'impureImports_')
  expect(c.jobs.map((j) => j.kind)).toEqual(['precompute'])
  const html = jinja(ok, 'impureImports_')
  for (const s of ['_s1', '_s2', '_s3']) expect(html).toContain(s)   // none was baked
  expect(html).not.toContain(process.env.HOME ?? '\u0000')
})

test('import.meta.env / .url / .dir are build-host input: imported and same-file helpers stay jobs', () => {
  const c = comp(manifest(ok), 'importMeta_')
  expect(c.jobs.map((j) => j.kind)).toEqual(['precompute'])
  const html = jinja(ok, 'importMeta_')
  for (const s of ['_s1', '_s2', '_s3', '_s4']) expect(html).toContain(s)   // none was baked
  expect(html).not.toContain('file://')
})

test('the evaluator never sees the build host environment (explicit allowlist)', async () => {
  const b = build(join(root, 'importmeta-bt'), { API_URL: 'https://secret.example' })
  expect(b.exitCode).not.toBe(0)   // import.meta in a buildTime closure is refused before anything runs
  expect(b.stderr.toString()).toMatch(/error build-time-impure ImpureMeta\.tsx:\d+:\d+ buildTime\(…\) reads `import\.meta`/)
  expect(b.stderr.toString() + b.stdout.toString()).not.toContain('secret.example')
})

test('buildTime bakes a package call, async included, into the template (no job, no worker)', () => {
  const bt = comp(manifest(ok), 'buildTime_')
  expect(bt.jobs).toEqual([])
  expect(bt.needs_worker).toBe(false)
  const html = jinja(ok, 'buildTime_')
  expect(html).toContain('<pre data-lang=\\"ts\\"><code>a &lt; b</code></pre>')
  expect(html).toMatch(/"k0": 0, "k1": 1, "k2": 4, "k3": 9/)   // key order survives
})

test('a buildTime closure that reads props stays a job and warns build-time-input', () => {
  const p = comp(manifest(ok), 'propsBuildTime_')
  expect(p.jobs.map((j) => j.kind)).toEqual(['precompute'])
  expect(okBuild.stderr.toString() + okBuild.stdout.toString()).toMatch(/warning build-time-input PropsBuildTime\.tsx:\d+:\d+ buildTime\(…\) reads code/)
})

test('a throwing buildTime is a build error naming the call site', () => {
  const b = build(join(root, 'throws'))
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toMatch(/error build-time Throws\.tsx:4:\d+ buildTime\(…\) failed at build: boom at build/)
})

test('buildTime that reaches process.env through an import is a build error, never a baked host value', () => {
  const b = build(join(root, 'envbt'))
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toMatch(/error build-time EnvBt\.tsx:\d+:\d+ buildTime\(…\) failed at build: build-eval: process\.env is not allowed/)
})

test('buildTime in a handler is the error build-time-client', () => {
  const b = build(join(root, 'client'))
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toMatch(/error build-time-client Client\.tsx:\d+:\d+ buildTime\(…\) is used by a handler/)
})

test('baked output equals the job path (dual run)', async () => {
  const ref = build(ok, { BRUST_BUILD_EVAL: '0' }, 'dist-ref')
  expect(ref.exitCode, ref.stderr.toString()).toBe(0)
  expect(comp(manifest(ok, 'dist-ref'), 'pure_').jobs.map((j) => j.kind)).toEqual(['precompute'])   // reference: the job stays
  const serve = async (dist: string) => {
    const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist], { cwd: ok, env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }, stdout: 'pipe', stderr: 'inherit' })
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
    const page = async (s: { base: string }) => (await fetch(`${s.base}/`)).text()
    const [baked, job] = [await page(a), await page(b)]
    expect(baked).toContain('<h1>3.14</h1>')
    expect(baked).toBe(job)
  } finally {
    await a.stop()
    await b.stop()
  }
}, 120_000)
