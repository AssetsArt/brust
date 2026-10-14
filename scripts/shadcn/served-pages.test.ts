// R34.58 gate: calendar and form used to be REFUSED by the build (island-prop on a host that is React already).
// They now build, and a page that builds must also be SERVED: `brust build` + `brust start` + fetch 200 with the
// React-rendered markup (a page can build and still be refused by the server's manifest check). Both are React
// hosts: the function props (`components`, `render`) live in the React tree and never cross the JSON boundary.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE, repo } from './paths.ts'

const ENTRY = '.rows/island-prop-routes.tsx'
const DIST = '.rows/dist-island-prop'
const bin = join(repo, 'packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(
    join(FIXTURE, ENTRY),
    `import { defineRoutes } from "@brust/core/routes"\nimport CalendarPage from "../pages/calendar"\nimport FormPage from "../pages/form"\nexport const routes = defineRoutes([\n  { path: "/calendar", Component: CalendarPage },\n  { path: "/form", Component: FormPage },\n])\n`,
  )
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', DIST], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', DIST, '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
}, 180_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, DIST), { recursive: true, force: true })
})

test('form is served: the React-rendered page carries the field the render prop builds', async () => {
  const r = await fetch(`${base}/form`)
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).toContain('data-slot="form-item"')
  expect(html).toContain('Username')
  expect(html).toContain('This is your public display name.')
  expect(html).toContain('<input')
  // The function never crosses to the page: no source text, no serialized props carrying it.
  expect(html).not.toContain('=>')
  expect(html).not.toMatch(/\son(click|change|submit)=/i)
})

test('calendar is served: the day grid DayPicker renders is in the HTML', async () => {
  const r = await fetch(`${base}/calendar`)
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).toContain('data-slot="calendar"')
  expect(html).toMatch(/role="grid"|rdp-/)
  expect(html).not.toContain('=>')
})
