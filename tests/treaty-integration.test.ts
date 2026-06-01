import { afterAll, beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'
import { client } from '../runtime/client/index.ts'
import type { Actions } from './fixtures/app/actions.ts'

/** End-to-end exercise of the treaty action wire (M1): `defineActions(...)` on
 * the server, `client<Actions>()` on the caller, over a REAL booted brust server.
 *
 * The fixture (tests/fixtures/app/actions.ts) registers:
 *   POST   /notes        — body: z.object({ text }), returns { id }
 *   GET    /whoami       — returns { user: cookie['user'] ?? null }
 *   DELETE /notes/{id}   — requireUser middleware (401 without a cookie)
 *
 * Asserts the wire contract: METHOD <prefix>/<path>, JSON object body, and the
 * treaty client's `{ data, error, status }` shape (NEVER throws on HTTP status).
 *
 * Boot harness mirrors tests/native-island.test.ts (cargo build jsx-rustc →
 * brust build → spawn → waitForReady → SIGINT), on a distinct port (3804).
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const PORT = 3804
const BASE_URL = `http://127.0.0.1:${PORT}`

let proc: ReturnType<typeof spawn> | undefined

async function waitForReady(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/ping`)
      if (res.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server didn't become ready at ${url}: ${String(lastErr)}`)
}

beforeAll(async () => {
  // Pre-flight 1: build jsx-rustc (the build CLI invokes it for native pages).
  const buildRustc = spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) {
    throw new Error(
      `cargo build -p jsx-rust-compiler --bin jsx-rustc failed (exit ${buildRustc.exitCode})`,
    )
  }

  // Pre-flight 2: brust build against the fixture entry (bakes native templates
  // + islands). Not strictly required for the action wire, but mirrors the
  // native-island harness so the booted server is in its production shape.
  const buildRes = spawnSync({
    cmd: ['bun', 'run', resolve(REPO_ROOT, 'runtime/cli/index.ts'), 'build', 'index.ts'],
    cwd: FIXTURE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (buildRes.exitCode !== 0) {
    const stdoutStr = buildRes.stdout ? new TextDecoder().decode(buildRes.stdout) : ''
    const stderrStr = buildRes.stderr ? new TextDecoder().decode(buildRes.stderr) : ''
    throw new Error(`brust build failed (exit ${buildRes.exitCode}):\n${stdoutStr}\n${stderrStr}`)
  }

  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      BRUST_PORT: String(PORT),
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForReady(BASE_URL)
}, 60_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    try {
      await proc.exited
    } catch {
      // Process may have already exited.
    }
  }
})

// Bun's fetch needs an absolute base — the browser default (a relative prefix)
// has no origin in a server-side test. Point the client at the booted server.
function api() {
  return client<Actions>({ prefix: `${BASE_URL}/_brust/action`, fetch: globalThis.fetch })
}

test('POST /notes with a valid body → data.id present, status 200', async () => {
  const { data, error, status } = await api().notes.post({ text: 'hello treaty' })
  expect(status).toBe(200)
  expect(error).toBeNull()
  expect(data?.id).toMatch(/^n-\d+$/)
})

test('POST /notes with a bad body (text not a string) → 422, error populated', async () => {
  const { data, error, status } = await api().notes.post({ text: 123 as never })
  expect(status).toBe(422)
  expect(data).toBeNull()
  expect(error).not.toBeNull()
  expect(error?.status).toBe(422)
})

test('GET /whoami without a cookie → 200, data.user === null', async () => {
  const { data, error, status } = await api().whoami.get()
  expect(status).toBe(200)
  expect(error).toBeNull()
  expect(data?.user).toBeNull()
})

test('GET /whoami with a user cookie → 200, data.user === alice', async () => {
  const { data, status } = await api().whoami.get({ headers: { cookie: 'user=alice' } })
  expect(status).toBe(200)
  expect(data?.user).toBe('alice')
})

test('DELETE /notes/{id} with NO user cookie → 401 (requireUser middleware)', async () => {
  const { error, status } = await api().notes({ id: 'n-1' }).delete()
  expect(status).toBe(401)
  expect(error).not.toBeNull()
  expect(error?.status).toBe(401)
})

test('DELETE /notes/{id} WITH a user cookie → 200, data.ok true + id echoed', async () => {
  const { data, error, status } = await api()
    .notes({ id: 'n-1' })
    .delete(undefined, { headers: { cookie: 'user=alice' } })
  expect(status).toBe(200)
  expect(error).toBeNull()
  expect(data?.ok).toBe(true)
  expect(data?.id).toBe('n-1')
})

test('unknown path → 404', async () => {
  const { error, status } = await (
    api() as never as { nope: { get: () => Promise<{ status: number; error: unknown }> } }
  ).nope.get()
  expect(status).toBe(404)
  expect(error).not.toBeNull()
})

test('wrong method (POST to GET-only /whoami) → 405', async () => {
  const { status, error } = await (
    api() as never as {
      whoami: { post: (b: unknown) => Promise<{ status: number; error: unknown }> }
    }
  ).whoami.post({})
  expect(status).toBe(405)
  expect(error).not.toBeNull()
})
