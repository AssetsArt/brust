// F333: an object literal passed to a native child and read with Object.entries / Object.keys keeps its JS key order
// (source order, integer-like keys first), as React prints it; a jinja map literal sorted it.
// Run alone: `bun test --timeout 120000 tests/server/literal-order.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { renderPage } from '../../packages/brust/test/fixtures/literal-order/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/literal-order')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
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
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const section = (html: string, id: string) => new RegExp(`<section[^>]*data-testid="${id}"[^>]*>(.*?)</section>`, 's').exec(html)?.[1]?.replace(/<!--.*?-->/g, '') ?? null
const items = (html: string, id: string) => [...(section(html, id) ?? '').matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]).join('|')
const keys = (html: string, id: string) => /<i[^>]*>([^<]*)<\/i>/.exec(section(html, id) ?? '')?.[1] ?? null

test('Object.entries / Object.keys of a literal prop follow JS key order, as in React', async () => {
  const served = await (await fetch(`${base}/`)).text()
  const react = renderPage()
  expect(items(react, 'words')).toBe('z=zz|a=aa|m=mm')
  expect(items(react, 'nums')).toBe('2=two|10=ten|b=bee|a=ay')
  for (const id of ['words', 'nums']) {
    expect(items(served, id), id).toBe(items(react, id))
    expect(keys(served, id), id).toBe(keys(react, id))
  }
})
