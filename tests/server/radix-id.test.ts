// F442 W3b: Radix's own `useId` (@radix-ui/react-id), recognised by the shape of its source, is React 19's useId under the
// `radix-` prefix: an id slot. The served HTML of a page with two Fields (a statement-level call, a deterministic id and
// one hoisted out of an attribute) equals React's own render, ids included, and the Field is not an island.
// Run alone: `bun test --timeout 120000 tests/server/radix-id.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/radix-id')
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

/** `<main>…</main>` of a document, with the attributes of every tag sorted, brust's `x-` directives and the void-tag slash dropped. */
function normalize(html: string): string {
  const main = /<main[\s\S]*<\/main>/.exec(html.replaceAll('<!-- -->', ''))![0]
  return main.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_m, tag: string, attrs: string, close: string) => {
    const list = [...attrs.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)].filter((a) => !a[1]!.startsWith('x-')).map((a) => `${a[1]}="${a[2] ?? ''}"`).sort()
    void close
    return `<${tag}${list.length ? ` ${list.join(' ')}` : ''}>`
  })
}

test('id.tsx is the published source of @radix-ui/react-id, byte for byte', () => {
  const map = join(app, '../../../node_modules/@radix-ui/react-id/dist/index.mjs.map')
  const published = JSON.parse(readFileSync(map, 'utf8')).sourcesContent[0] as string
  expect(readFileSync(join(app, 'id.tsx'), 'utf8')).toBe(published)
})

test('the page is native and the Field is not an island', () => {
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
  expect(tiers.page).toBe('native')
  expect(tiers.field).not.toBe('react')
})

/** Ids renamed by first appearance (`radix-#0`, `radix-#1`, …): brust and React spell their id slots differently (React's `_R_2_`, brust's
 * per-instance `brust-r0-…`, which the client reads back from props), so the comparison is of which attributes share an id. */
function renumber(html: string): string {
  const seen = new Map<string, string>()
  return html.replace(/radix-[A-Za-z0-9_.-]+/g, (id) => {
    if (!seen.has(id)) seen.set(id, `radix-#${seen.size}`)
    return seen.get(id)!
  })
}

test('the served HTML equals the React render, id sharing included (two Fields, a deterministic id)', async () => {
  const served = normalize(await (await fetch(`${base}/`)).text())
  const { default: Page } = await import(join(app, 'Page.tsx'))
  const { createElement } = await import(Bun.resolveSync('react', app))
  const { renderToStaticMarkup } = await import(Bun.resolveSync('react-dom/server', app))
  const react = normalize(renderToStaticMarkup(createElement(Page)))
  // React's ids are `radix-` + its own id: four radix ids, each Field's label/input pair sharing one and its description another
  expect(renumber(served)).toBe(renumber(react))
  expect(served).toContain('id="given"')
  const ids = [...served.matchAll(/ id="(radix-[^"]+)"/g)].map((m) => m[1])
  expect(ids.length).toBe(2)
  expect(new Set(ids).size).toBe(2)
  const described = [...served.matchAll(/aria-describedby="(radix-[^"]+)"/g)].map((m) => m[1])
  expect(new Set([...ids, ...described]).size).toBe(5)
})
