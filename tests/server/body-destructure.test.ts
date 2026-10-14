// S3 F153b part 2 (R34.66): the props pattern written in the component body (radix-ui's Separator and AspectRatio).
// Each component is static with no client chunk, the page is built AND started, and its HTML equals React's
// renderToStaticMarkup of the same page. Run alone: `bun test --timeout 120000 tests/server/body-destructure.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/shadcn')
const dist = '.rows/dist-started-body-destructure'
const entry = 'started/body-destructure-routes.tsx'
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', entry, '--out-dir', dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist, '--entry', entry], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
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
  rmSync(join(app, dist), { recursive: true, force: true })
})

test('every component is static and the page loads no client JS', () => {
  const m = JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))
  const comps = Object.values(m.components) as any[]
  expect(comps.map((c) => c.tier).every((t) => t === 'static')).toBe(true)
  expect(comps.every((c) => c.client === null)).toBe(true)
})

test("the served HTML equals React's for the same page", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const start = html.indexOf('<main>')
  const end = html.indexOf('</main>', start) + '</main>'.length
  expect(start).toBeGreaterThan(-1)
  const ours = html.slice(start, end)
  const code = `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import Page from './started/body-destructure/Page.tsx'; process.stdout.write(renderToStaticMarkup(createElement(Page)))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  // serialisation only: void/boolean spelling, newlines between components, and the order of the declarations of a
  // style attribute (brust sorts them; distinct properties do not depend on the order)
  const norm = (h: string) =>
    h
      .replace(/\/>/g, '>')
      .replace(/=""/g, '')
      .replace(/>\s+</g, '><')
      .replace(/style="([^"]*)"/g, (_, d: string) => `style="${d.split(';').filter(Boolean).sort().join(';')}"`)
  expect(norm(ours)).toBe(norm(r.stdout.toString()))
  expect(ours).toContain('data-orientation="vertical"')
  expect(ours).toContain('role="none"')
  expect(ours).toContain('padding-bottom:50%')
})
