// shadcn S1 icon-shapes (R34.76-R34.78) end to end: a page that imports through the tsconfig `@/` alias, a `children ?? <X/>`
// and a `label || <X/>` fallback, and a spread onto a lucide icon is served WITHOUT an island, and its HTML equals what the
// real React render of the same components produces (R34.3), modulo attribute order.
// Run alone: `bun test --timeout 120000 tests/server/icon-shapes.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/icon-shapes')
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

test('the page is static: no island of its own', () => {
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
  expect(tiers.page).toBe('static')
  expect(tiers.spinner).toBe('static')
  // The page that gives `Sep` children falls back to React (`children-read`), not to a wrong answer.
  expect(tiers.withChildren).toBe('react')
  // An icon that reads aria-*/role/title itself: refused at the call site, rendered by React.
  expect(tiers.labelled).toBe('react')
})

async function react(file: string): Promise<string> {
  const { default: Page } = await import(join(app, file))
  const { createElement } = await import(Bun.resolveSync('react', app))
  const { renderToStaticMarkup } = await import(Bun.resolveSync('react-dom/server', app))
  return normalize(renderToStaticMarkup(createElement(Page)))
}

test('the served HTML equals the React render (alias imports, ?? and || fallbacks, icon spread)', async () => {
  const served = normalize(await (await fetch(`${base}/`)).text())
  expect(served).toBe(await react('Page.tsx'))
  expect(served).toContain('<i>none</i>')
  expect(served).toContain('>given<')
  expect(served).toContain('data-x="1"')
  // `label=""`: `||` falls back as JS does.
  expect(served.match(/<i>none<\/i>/g)?.length).toBe(2)
})

test('children given to a component that tests `children` render as React renders them', async () => {
  const served = normalize(await (await fetch(`${base}/children`)).text())
  expect(served).toBe(await react('WithChildren.tsx'))
  expect(served).toContain('>custom<')
  expect(served).toContain('>0<')
})

test('an icon given aria-*, role, title or nonScalingStroke through a spread equals the React render (a labelled icon is not hidden)', async () => {
  const served = normalize(await (await fetch(`${base}/labelled`)).text())
  expect(served).toBe(await react('Labelled.tsx'))
  expect(served).toContain('aria-label="next"')
  // React drops `aria-hidden` when the icon is labelled; the page must not print both.
  expect(served).not.toMatch(/aria-hidden="true"[^>]*aria-label|aria-label[^>]*aria-hidden="true"/)
  expect(served).not.toContain('nonScalingStroke')
})
