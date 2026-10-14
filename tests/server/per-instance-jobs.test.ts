// F142 (plan 2026-10-14-shadcn-per-instance-jobs, R34.42/R34.47): shadcn's table page maps a module const into
// TableRow/TableCell, components with a job of their own (`cn`) whose props never read the row. Each instance is fed
// once (a static record) instead of falling back to React. The page is built AND started (brust start validates
// the manifest the generator never loads) and its HTML equals React's renderToStaticMarkup of the same page. Run
// alone: `bun test --timeout 120000 tests/server/per-instance-jobs.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/shadcn')
const dist = '.rows/dist-started-table'
const entry = 'started/table-routes.tsx'
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

test('the table page is static, fed once per instance, and starts', () => {
  const m = JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))
  const comps = Object.values(m.components) as any[]
  // Every component static, no client chunk: the page loads no JS.
  expect(comps.map((c) => c.tier).every((t) => t === 'static')).toBe(true)
  expect(comps.every((c) => c.client === null)).toBe(true)
  // Every instance record is static: one job call each, not one per row of a list the server cannot index.
  const records = comps.flatMap((c) => c.children)
  // Table, TableCaption, TableHeader, TableRow, TableHead x4, TableBody, TableRow, TableCell x4.
  expect(records.length).toBe(14)
  expect(records.every((r: any) => r.instances === 'static')).toBe(true)
})

test("the served HTML equals React's for the same page", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const start = html.indexOf('<div data-slot="table-container"')
  const end = html.indexOf('</table></div>', start) + '</table></div>'.length
  expect(start).toBeGreaterThan(-1)
  const ours = html.slice(start, end)
  const code = `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import Page from './pages/table.tsx'; process.stdout.write(renderToStaticMarkup(createElement(Page)))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  expect(ours).toBe(r.stdout.toString())
  // Both rows are there, each cell with its own class.
  expect(ours.match(/<tr data-slot="table-row"/g)?.length).toBe(3)
  expect(ours).toContain('INV002')
})
