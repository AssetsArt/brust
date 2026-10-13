// L1 (gap-const-fold) from the outside: module consts fold into the template with no job (G5/G9/G10),
// and an inlined child whose job is a real one (a call) still has it planned and run (R1.4).
// Same harness as e2e-child-chunks.test.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/module-const')
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


test('a module const (and an imported one) renders through Page → Panel → List with no worker', async () => {
  const manifest = JSON.parse(await Bun.file(join(app, 'dist/manifest.json')).text())
  for (const [id, c] of Object.entries<{ needs_worker: boolean }>(manifest.components)) {
    if (id.startsWith('fold_') || id.startsWith('list_')) expect(c.needs_worker).toBe(false)
  }
  const html = await (await fetch(`${base}/`)).text()
  expect(html).toContain('title="Folded rows"')
  expect(html).toContain('<li>one</li>')
  expect(html).toContain('<li>two</li>')
})

test('an inlined child with a genuine job still runs it', async () => {
  const html = await (await fetch(`${base}/job`)).text()
  expect(html).toMatch(/<li>a<\/li><li>b<\/li><li>c<\/li>/)
})
