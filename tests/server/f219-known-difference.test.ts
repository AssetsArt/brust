// F219, KNOWN DIFFERENCE pinned by lead ruling (Detoro, note on ledger-dew): a module C that changes module B's exported
// objects when it loads (`import './f219/patch'`: LABELS.a = 'patched', list.push('y')) is not seen. brust reads B's
// exported values as declared (the const folder reads B's source), so it serves "one x" where React renders
// "patched x,y". Ledger F230 (an app-wide pass over every module the build loads) closes it: when it lands this test
// FLIPS, and must then assert served == React.
// Run alone: `bun test --timeout 120000 tests/server/f219-known-difference.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/f219-routes.tsx'
const OUT = '.rows/dist-f219'
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\nimport Page from "../repro/f219-page"\nexport const routes = defineRoutes([\n  { path: "/f219", Component: Page },\n])\n`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', OUT], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', OUT, '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
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
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, OUT), { recursive: true, force: true })
})

const text = (html: string, id: string) =>
  new RegExp(`<p[^>]*data-testid="${id}"[^>]*>(.*?)</p>`, 's').exec(html)?.[1].replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

test('KNOWN DIFFERENCE until F230: a load-time write from another module is not seen', async () => {
  // React's own render, in the fixture app (its react / react-dom).
  const script = join(FIXTURE, '.rows/f219-react.tsx')
  writeFileSync(script, `import { renderToString } from 'react-dom/server'\nimport Page from '../repro/f219-page'\nprocess.stdout.write(renderToString(<Page />))\n`)
  const r = Bun.spawnSync([process.execPath, script], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  rmSync(script, { force: true })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  const react = r.stdout.toString()
  expect(text(react, 'p')).toBe('patched x,y')
  expect(text(react, 'q')).toBe('patched x,y 0')
  const served = await (await fetch(`${base}/f219`)).text()
  // F230 flips these to React's values above.
  expect(text(served, 'p')).toBe('one x')
  expect(text(served, 'q')).toBe('one x 0')
})
