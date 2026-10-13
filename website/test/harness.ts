// website/test/harness.ts — shared by the site's test files: build into a fresh dist-test-* dir, start brust on an
// ephemeral port (--port 0, read back from "listening on"), stop it with a bounded drain, and wait on observable
// state instead of sleeping. No two test files can share a port or an output dir.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'bun:test'
import type { Page } from 'playwright'

export const app = join(import.meta.dir, '..')
export const bin = join(app, '../packages/brust/bin/brust')
/** beforeAll/afterAll budget: a build plus a cold server under load. */
export const HOOK_MS = 240_000
/** Per-test budget for browser tests, and the wait budget for one observable change. */
export const TEST_MS = 120_000
export const WAIT_MS = 60_000

export interface Manifest {
  routes: { pattern: string }[]
  components: Record<string, { tier: string; client: string | null; jobs: { kind: string }[] }>
}

/** Removes `dist-test-<name>` and returns its absolute path (call again in afterAll to clean up). */
export function freshOut(name: string): string {
  const dir = join(app, `dist-test-${name}`)
  rmSync(dir, { recursive: true, force: true })
  return dir
}

/** `brust build <entry> --out-dir <out>`: exit 0, empty stderr, and no warning except the ones allowed. */
export function build(entry: string, out: string, allow: RegExp = /^warning hook-unsupported /): Manifest {
  const b = Bun.spawnSync([bin, 'build', entry, '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  expect(b.stdout.toString().split('\n').filter((l) => l.startsWith('warning') && !allow.test(l))).toEqual([])
  return JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
}

export interface Server {
  base: string
  stop: () => Promise<void>
}

/** `brust start` on an ephemeral port; resolves once it prints ready. */
export async function serve(out: string, workers = 2): Promise<Server> {
  const proc = Bun.spawn([bin, 'start', '--dist-dir', out, '--port', '0', '--workers', String(workers)], {
    cwd: app,
    env: { ...process.env, BRUST_ADDR: '127.0.0.1', BRUST_DIST_DIR: out, BRUST_DRAIN_TIMEOUT_MS: '1000', BRUST_PORT: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  const deadline = Date.now() + HOOK_MS
  while (!/\[brust\] ready/.test(log)) {
    if (Date.now() > deadline) throw new Error(`brust start not ready in time:\n${log}`)
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}${await new Response(proc.stderr as ReadableStream).text()}`)
    log += dec.decode(value, { stream: true })
  }
  const base = `http://${/listening on (\S+)/.exec(log)![1]}`
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  void new Response(proc.stderr as ReadableStream).text()
  return {
    base,
    stop: async () => {
      proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'late')])) === 'late') proc.kill('SIGKILL')
      await proc.exited
    },
  }
}

/** The manifest record of the one component compiled from `<Name>.tsx`. */
export function component(m: Manifest, name: string) {
  const prefix = `${name[0]!.toLowerCase()}${name.slice(1)}_`
  const hits = Object.entries(m.components).filter(([id]) => id.startsWith(prefix))
  expect([name, hits.length]).toEqual([name, 1])
  return hits[0]![1]
}

/** Polls `read` until `ok` holds (or WAIT_MS passes) and returns the last value; the caller asserts on it. */
export async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < end) {
    await Bun.sleep(50)
    v = await read()
  }
  return v
}

/** Waits until the native component at `selector` has mounted: it sets data-ready on an inner element from its
 * first effect, which runs after its handlers are bound. `nth` picks one of several instances. */
export async function ready(page: Page, selector: string, nth = 0): Promise<void> {
  await page.locator(selector).nth(nth).locator('[data-ready]').first().waitFor({ timeout: WAIT_MS })
}
