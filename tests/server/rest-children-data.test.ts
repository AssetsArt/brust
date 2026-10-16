// F300 / F324 served: a component that passes its ...rest to a specialised state Provider and is called with a JSX
// child. The brust page must show the child inside the button, as React does (it used to print the button without it);
// the build refuses the native path (children-rest) so the page renders with React, not with the child dropped.
// Run alone: `bun test --timeout 120000 tests/server/rest-children-data.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { renderPage } from '../../packages/brust/test/fixtures/rest-children-data/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/rest-children-data')
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

const button = (h: string) => /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(h)?.[1]?.replace(/<!--[\s\S]*?-->/g, '')

test('the JSX child reaches the button, as in React', async () => {
  const react = renderPage()
  expect(button(react)).toContain('<span>hello</span>')
  const html = await (await fetch(`${base}/`)).text()
  expect(button(html)).toContain('<span>hello</span>')
})

test('the build refused the native path: the caller is a React island (children-rest)', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  const page = Object.entries(m.components).find(([k]) => k.startsWith('page_'))![1]
  expect(page.tier).toBe('react')
})
