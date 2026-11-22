// F615: a page omits a prop whose module default decides a branch of the component it renders; a real React island sits
// in both branches. The build succeeds, the page is not a React island, and the island's server output is in the live
// branch exactly once per row (default `on: false` -> the plain branch; `on: true` -> the side branch), never in the dead one.
// Run alone: `bun test --timeout 180000 tests/server/omitted-prop-guard.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/omitted-prop-guard')
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
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('no page is a React island', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  for (const [id, c] of Object.entries(m.components)) if (id.startsWith('page')) expect([id, c.tier]).not.toEqual([id, 'react'])
})

for (const [path, live, dead] of [
  ['/off', 'plain', 'side'],
  ['/on', 'side', 'plain'],
] as const) {
  test(`${path}: the island renders once per row in the ${live} branch, never in the ${dead} one`, async () => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<b class="rc-hello">slot</b>')
    expect(html).not.toContain(`class="${dead}"`)
    const branch = html.slice(html.indexOf(`class="${live}"`))
    for (const id of ['a', 'b']) {
      expect(html.split(`data-island="${id}"`).length - 1).toBe(1)
      expect(branch).toContain(`data-island="${id}"`)
      expect(html).toContain(`${id}<!-- -->:<!-- -->1`)
    }
  })
}
