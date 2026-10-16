// F321 + F322: loader data that differs ONLY in key order must be served in its own order, request after request (job cache
// keys include the key order of the loader's text), and integer-like keys enumerate first, ascending, as in JS (a loader
// object and a literal written out of order). Each response equals React's own render.
// Run alone: `bun test --timeout 120000 tests/server/loader-order.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { renderPage } from '../../packages/brust/test/fixtures/loader-order/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/loader-order')
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

const attr = (html: string, id: string, name: string) => new RegExp(`<[^>]*data-testid="${id}"[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1] ?? null
const list = (html: string, id: string) => [...(new RegExp(`<ul[^>]*data-testid="${id}"[^>]*>(.*?)</ul>`, 's').exec(html)?.[1] ?? '').matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]!.replace(/<!--.*?-->/g, '')).join('|')
const island = (html: string) => /<div[^>]*data-testid="box"[^>]*>/.exec(html)?.[0]?.replace(/&quot;/g, '"') ?? null
const cfg = (html: string) => /<code data-testid="cfg">([^<]*)<\/code>/.exec(html)?.[1]?.replace(/&quot;/g, '"') ?? null

test('two payloads that differ only in key order are each served in their own order (second request == React)', async () => {
  for (const o of ['a', 'b', 'a', 'b']) {
    const served = await (await fetch(`${base}/?o=${o}`)).text()
    const react = renderPage(o)
    expect(attr(served, 'plain', 'style'), `plain ${o}`).toBe(attr(react, 'plain', 'style'))
    expect(attr(react, 'plain', 'style')).toBe(o === 'b' ? 'margin:0;margin-top:5px;color:red' : 'margin-top:5px;margin:0;color:red')
    expect(island(served), `island ${o}`).toBe(island(react))
    expect(cfg(served), `cfg ${o}`).toBe(cfg(react))
  }
})

test('integer-like keys enumerate first and ascending, in a loader object and in a literal', async () => {
  const served = await (await fetch(`${base}/?o=a`)).text()
  const react = renderPage('a')
  expect(list(react, 'table')).toBe('2=two|10=ten|b=bee|a=ay')
  expect(list(served, 'table')).toBe(list(react, 'table'))
  expect(list(react, 'literal')).toBe('2=two|10=ten|b=bee')
  expect(list(served, 'literal')).toBe(list(react, 'literal'))
  expect(cfg(react)).toBe('{"2":"two","10":"ten","b":"bee","a":"ay"}')
  expect(cfg(served)).toBe(cfg(react))
})
