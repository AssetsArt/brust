// F66 from the outside: builds the child-chunks fixture with the real CLI, starts it and checks
// that every chunk-bearing native child (and grandchild) gets exactly one script tag, a chunk-less
// child none, and an all-static page no runtime at all. Same harness as e2e.test.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/child-chunks')
const bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let stdout = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  while (!/\[brust\] ready/.test(stdout)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${stdout}`)
    stdout += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(stdout)![1]}`
  // Keep draining: a closed pipe would make the server's next println! panic.
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      stdout += dec.decode(value, { stream: true })
    }
  })()
}, 120_000)

afterAll(async () => {
  try {
    if (proc) {
      proc.kill('SIGINT')
      const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])
      if (exited === undefined) {
        proc.kill('SIGKILL')
        await proc.exited
      }
    }
  } finally {
    rmSync(join(app, 'dist'), { recursive: true, force: true })
  }
})

const scripts = (html: string) => [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]!)

test('each chunk-bearing native child and grandchild is linked exactly once; a chunk-less child is not', async () => {
  const r = await fetch(`${base}/`)
  expect(r.status).toBe(200)
  const html = await r.text()
  const src = scripts(html)
  const of = (name: string) => src.filter((s) => new RegExp(`^/_brust/client/${name}_[0-9a-f]{8}-[0-9a-f]{10}\\.js$`).test(s))
  expect(of('toggle')).toHaveLength(1)
  expect(of('deep')).toHaveLength(1)
  expect(of('counted')).toHaveLength(1)
  expect(src.some((s) => s.includes('/static_'))).toBe(false)
  expect(src.filter((s) => /\/runtime-[0-9a-f]{10}\.js$/.test(s))).toHaveLength(1)
  expect(new Set(src).size).toBe(src.length)
  const chunk = await fetch(`${base}${of('toggle')[0]}`)
  expect(chunk.status).toBe(200)
  await chunk.text()
})

test('a page whose components are all static gets no runtime script (S9)', async () => {
  const r = await fetch(`${base}/static`)
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).toContain('<p>plain</p>')
  expect(html).not.toContain('<script')
})
