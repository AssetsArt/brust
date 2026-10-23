// L22 from the outside: a component from a package (here a tiny local one, no network) in a static
// and in a native parent builds, is server-rendered, and ships a hydratable island chunk.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { installTinyIcons } from './fixtures/ext-island/install'

const app = join(import.meta.dir, 'fixtures/ext-island')
const bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let uninstall: () => void

beforeAll(async () => {
  uninstall = installTinyIcons(app)
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
}, 120_000)

afterAll(async () => {
  try {
    if (proc) {
      proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
        proc.kill('SIGKILL')
        await proc.exited
      }
    }
  } finally {
    rmSync(join(app, 'dist'), { recursive: true, force: true })
    uninstall?.()
  }
})

test('a package component in a static parent is server-rendered with its literal props', async () => {
  const html = await (await fetch(`${base}/`)).text()
  expect(html).toContain('<brust-island style="display:contents" data-id="heart_')
  expect(html).toContain('width="16"')
  expect(html).toContain('<title>loved</title>')
})

test('a package component in a native parent is server-rendered next to the native markup', async () => {
  const html = await (await fetch(`${base}/native`)).text()
  expect(html).toContain('<brust-island style="display:contents" data-id="heart_')
  expect(html).toContain('width="20"')
  expect(html).toMatch(/<button[^>]*>0<\/button>/)
})

test('the island chunk is served', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const chunk = /\/_brust\/client\/react-heart_[0-9a-f]{8}-[0-9a-f]{10}\.js/.exec(html)
  expect(chunk).not.toBeNull()
  expect((await fetch(`${base}${chunk![0]}`)).status).toBe(200)
})
