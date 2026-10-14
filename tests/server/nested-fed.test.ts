// F164 PR 2a (R34.96 static-wrapper case, F169) end to end: a static wrapper around a child with a job is served WITHOUT an
// island, its HTML equals the real React render (R34.3), the second use (no prop) gets the child's default like React, and a
// useId child handed through a component that repeats its children renders distinct ids (React tier), not the same id twice.
// Run alone: `bun test --timeout 120000 tests/server/nested-fed.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/nested-fed')
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

/** `<main>…</main>` of a document, with the attributes of every tag sorted and comment markers dropped. */
function normalize(html: string): string {
  const main = /<main[\s\S]*<\/main>/.exec(html.replaceAll('<!-- -->', ''))![0]
  return main.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_m, tag: string, attrs: string, close: string) => {
    const list = [...attrs.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)].map((a) => `${a[1]}="${a[2] ?? ''}"`).sort()
    return `<${tag}${list.length ? ` ${list.join(' ')}` : ''}${close}>`
  })
}


function normalizeAll(html: string) { return normalize(html) }

async function react(file: string): Promise<string> {
  const { default: Page } = await import(join(app, file))
  const { createElement } = await import(Bun.resolveSync('react', app))
  const { renderToStaticMarkup } = await import(Bun.resolveSync('react-dom/server', app))
  return normalizeAll(renderToStaticMarkup(createElement(Page)))
}

test('the page keeps its tier and the wrapper is not an island', () => {
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
  expect(tiers.page).toBe('static')
  expect(tiers.wrapper).toBe('static')
  expect(tiers.chain).toBe('react')
  expect(tiers.kids).toBe('static')
})

test('the served HTML equals the React render (wrapper with a prop, without, direct, with an undefined prop)', async () => {
  const served = normalize(await (await fetch(`${base}/`)).text())
  expect(served).toBe(await react('Page.tsx'))
  expect(served).toContain('tone-A')
  expect(served).toContain('tone-DIRECT')
  // Two wrappers without a tone: the child's default `info`, as React applies it.
  expect(served.match(/tone-INFO/g)?.length).toBe(2)
})

test('a useId child through a component that passes its children to a repeater has distinct ids', async () => {
  const html = await (await fetch(`${base}/chain`)).text()
  const ids = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1])
  expect(ids.length).toBe(2)
  expect(new Set(ids).size).toBe(2)
})

test('a wrapper with a fed child before and after its slot content (which itself holds fed children) maps every instance to its own data', async () => {
  const served = normalize(await (await fetch(`${base}/order`)).text())
  expect(served).toBe(await react('Order.tsx'))
  // Document order: w1 first, slot1, last, then the second wrapper: each label is its own instance's.
  const order = [...served.matchAll(/tone-(\w+)/g)].map((m) => m[1])
  expect(order).toEqual(['W1', 'SLOT1', 'LAST', 'W2', 'SLOT2', 'LAST'])
})
