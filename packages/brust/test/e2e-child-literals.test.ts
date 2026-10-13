// L3 (gap-child-literals, F105) from the outside: a fed inlined child gets literal props and
// template expressions over the parent's props (and the row); literals are part of the job key
// (R3.1), and a state-fed prop still falls back to React (F96). Same harness as e2e-module-const.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/child-literals')
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


test('two literal instances of one child render their own outputs', async () => {
  const html = await (await fetch(`${base}/`)).text()
  expect(html).toContain('data-lang="ts"')
  expect(html).toContain('a|b')
  expect(html).toContain('data-lang="js"')
  expect(html).toContain('c|d')
})

test('a cache() key over a literal prop keeps the instances apart', async () => {
  for (let i = 0; i < 2; i++) {
    const html = await (await fetch(`${base}/`)).text()
    expect(html).toContain('k1+k2')
    expect(html).toContain('k3+k4')
  }
})

test('expressions over the props and the row are evaluated by the server', async () => {
  const html = await (await fetch(`${base}/exprs`)).text()
  expect(html).toContain('hi|HI')
  expect(html).toContain('data-lang="rs"')
  expect(html).toContain('x|y')
  expect(html).toContain('z|w')
  expect(html.match(/data-lang="txt"/g)?.length).toBe(2)
})

test('a state-fed precomputed prop falls back to React and still builds (F96)', async () => {
  const manifest = JSON.parse(await Bun.file(join(app, 'dist/manifest.json')).text())
  const [id, rec] = Object.entries<{ tier: string; children: unknown[] }>(manifest.components).find(([k]) => k.startsWith('reactive_'))!
  expect(id).toBeTruthy()
  expect(rec.tier).toBe('react')
  expect(rec.children).toEqual([])
  const html = await (await fetch(`${base}/reactive`)).text()
  expect(html).toContain('r|s0')
})
