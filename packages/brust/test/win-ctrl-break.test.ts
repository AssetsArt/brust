// F492 W3 (Windows only): a console Ctrl+Break reaches `brust start` as SIGBREAK and drains it like Ctrl+C: exit 0, the port refuses
// connections. The control event is sent to the server's own process group on a console the helper creates (helpers/win-ctrl-break.ts),
// the closest a CI step gets to a user at a terminal. Run alone: `bun test --timeout 180000 test/win-ctrl-break.test.ts` (on Windows).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/base-path-root')
const bin = join(import.meta.dir, '../bin/brust')
const helper = join(import.meta.dir, 'helpers/win-ctrl-break.ts')
const win = process.platform === 'win32'

beforeAll(() => {
  if (!win) return
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
}, 180_000)
afterAll(() => rmSync(join(app, 'dist'), { recursive: true, force: true }))

test.skipIf(!win)('Ctrl+Break in a console drains the server: it exits 0 by itself and the port refuses connections', async () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port as number
  s.stop(true)
  const h = Bun.spawn([process.execPath, helper, process.execPath, bin, String(port)], { cwd: app, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' } })
  const [out, err] = await Promise.all([new Response(h.stdout).text(), new Response(h.stderr).text()])
  await h.exited
  console.log(`[F492] ctrl-break helper: ${out.trim()} ${err.trim()}`)
  const r = JSON.parse(out.trim().split('\n').pop()!) as { error?: string; sent?: boolean; exited?: boolean; exitCode?: number; ms?: number; refused?: boolean }
  expect(r.error).toBeUndefined()
  expect(r.sent).toBe(true)
  expect(r.exited).toBe(true)
  expect(r.exitCode).toBe(0)
  expect(r.refused).toBe(true)
}, 180_000)
