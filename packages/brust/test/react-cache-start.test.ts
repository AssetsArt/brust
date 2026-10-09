// A react island importing `{ cache }` from `@brust/core` builds AND serves (m2c review round 3):
// `dist/jobs.js` keeps `@brust/core` external (the worker provides it) instead of bundling the
// server package — whose worker auto-start would run inside the worker and exit it (code 13).
// Run on its own: `bun test --timeout 120000 test/react-cache-start.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/safety/react-cache')
const bin = join(import.meta.dir, '../bin/brust')
// Inside the package (gitignored `dist/`): the external `@brust/core` resolves from the dist.
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

test('brust start serves a react island that imports { cache } from @brust/core (200, worker stays up)', async () => {
  rmSync(dist, { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  expect(readFileSync(join(dist, 'jobs.js'), 'utf8')).not.toMatch(/registerWorker|startServer|\.node["']/)

  const env: Record<string, string | undefined> = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  delete env.NODE_ENV
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  let out = ''
  let err = ''
  const pump = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const dec = new TextDecoder()
    const r = s.getReader()
    for (;;) {
      const { done, value } = await r.read()
      if (done) return
      add(dec.decode(value, { stream: true }))
    }
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>, (t) => {
    out += t
  })
  void pump(proc.stderr as ReadableStream<Uint8Array>, (t) => {
    err += t
  })
  try {
    const t0 = Date.now()
    while (!/\[brust\] ready/.test(out)) {
      if (proc.exitCode !== null) throw new Error(`brust start exited before ready:\n${out}\n${err}`)
      if (Date.now() - t0 > 30_000) throw new Error(`not ready in 30 s:\n${out}\n${err}`)
      await Bun.sleep(20)
    }
    const base = `http://${/listening on (\S+)/.exec(out)![1]}`
    const r = await fetch(`${base}/`)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toMatch(/<brust-island data-id="counter_[0-9a-f]{8}"[^>]*><b>x<!-- -->:<!-- -->0<\/b><\/brust-island>/)
    expect(proc.exitCode).toBeNull()
    expect(err).not.toContain('exited')
  } finally {
    proc.kill('SIGINT')
    const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])
    if (code === undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
}, 120_000)
