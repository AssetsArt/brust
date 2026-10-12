// dangerouslySetInnerHTML golden on the Rust server: cf-min's /raw/{kind} page served by a real `brust start`.
// The same page is probed on core-cf by tests/cf/cf-min.test.ts. Run alone: `bun test --timeout 120000 tests/server/inner-html.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/cf-min')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
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
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
}, 120_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const page = async (kind: string) => {
  const r = await fetch(`${base}/raw/${kind}`)
  expect(r.status).toBe(200)
  return r.text()
}

test('a string __html renders as markup; a sibling {text} stays escaped', async () => {
  const html = await page('html')
  expect(html).toContain('<div id="raw" x-raw><b>x</b></div>')
  expect(html).toContain('<p id="text">&lt;b&gt;x&lt;/b&gt;</p>')
})

test('null __html renders an empty element', async () => {
  expect(await page('null')).toContain('<div id="raw" x-raw></div>')
})

test('a number __html renders its string', async () => {
  expect(await page('num')).toContain('<div id="raw" x-raw>7</div>')
})
