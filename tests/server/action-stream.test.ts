// F475 served: a `[actions] stream` route against a real `brust start` actions-only server. A 96 MiB chunked upload
// reaches the app byte-exact while the server's resident set stays flat; a body past `max_stream_bytes` mid-stream is
// answered 413 whatever the app said; a second upload over `max_streams = 1` is refused 503 before a byte is read. Run
// alone: `bun test --timeout 300000 tests/server/action-stream.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

const run = join(import.meta.dir, '../../packages/brust/test/fixtures/action-stream')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const MiB = 1 << 20
const CEILING = 96 * MiB
let proc: ReturnType<typeof Bun.spawn>
let host = ''
let port = 0

beforeAll(async () => {
  rmSync(join(run, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', BRUST_ACTIONS_BASE_URL: '' }
  const b = Bun.spawnSync([bin, 'build', '--actions-only'], { cwd: run, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: run, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  const addr = /listening on (?:http:\/\/)?(\S+)/.exec(log)![1]!
  host = addr.slice(0, addr.lastIndexOf(':'))
  port = Number(addr.slice(addr.lastIndexOf(':') + 1))
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if (proc && (await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(run, 'dist'), { recursive: true, force: true })
})

/** Deterministic bytes: chunk `i` of `size` bytes. */
function chunk(i: number, size: number): Uint8Array {
  const c = new Uint8Array(size)
  let x = (i * 2654435761) >>> 0
  for (let k = 0; k < size; k += 4) {
    x = (x * 1664525 + 1013904223) >>> 0
    c[k] = x
    c[k + 1] = x >>> 8
    c[k + 2] = x >>> 16
    c[k + 3] = x >>> 24
  }
  return c
}

interface Raw {
  status: number
  head: string
  body: string
}

/** A raw HTTP/1.1 chunked POST (fetch would buffer or hide a refusal): writes `count` chunks of `size` bytes, waiting
 * on `gate` before each chunk after the first, then reads the answer. A write error after the server answered (it
 * closes a refused upload) does not hide the answer. */
function rawUpload(path: string, count: number, size: number, gate?: () => Promise<void>): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port })
    const got: Buffer[] = []
    s.on('data', (d) => got.push(d))
    s.on('error', () => {})
    s.on('close', () => {
      const text = Buffer.concat(got).toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end < 0) return reject(new Error(`no answer on ${path} (${text.length} bytes)`))
      const head = text.slice(0, end)
      resolve({ status: Number(head.split(' ')[1]), head: head.toLowerCase(), body: text.slice(end + 4) })
    })
    const write = (b: Uint8Array | string) =>
      new Promise<void>((ok) => {
        if (s.destroyed || s.writableEnded) return ok()
        if (s.write(b)) ok()
        else s.once('drain', ok)
      })
    void (async () => {
      await write(`POST ${path} HTTP/1.1\r\nhost: ${host}:${port}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n`)
      for (let i = 0; i < count && !s.destroyed; i++) {
        if (i > 0 && gate) await gate()
        await write(`${size.toString(16)}\r\n`)
        await write(chunk(i, size))
        await write('\r\n')
      }
      await write('0\r\n\r\n')
    })()
  })
}

const rss = async () => ((await (await fetch(`http://${host}:${port}/rss`)).json()) as { rss: number }).rss

test('a 96 MiB chunked upload reaches the app byte-exact; the server RSS grows by less than 32 MiB', async () => {
  // Warm up the worker, the allocator and the JIT, then take the baseline.
  expect((await rawUpload('/upload', 4, MiB)).status).toBe(200)
  const base = await rss()
  let peak = base
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, await rss())
      await Bun.sleep(25)
    }
  })()
  const want = new Bun.CryptoHasher('sha256')
  for (let i = 0; i < 96; i++) want.update(chunk(i, MiB))
  const r = await rawUpload('/upload', 96, MiB)
  sampling = false
  await sampler
  peak = Math.max(peak, await rss())
  expect(r.status).toBe(200)
  const body = r.body.slice(r.body.indexOf('{'), r.body.lastIndexOf('}') + 1)
  expect(JSON.parse(body)).toEqual({ bytes: 96 * MiB, sha256: want.digest('hex') })
  expect(peak - base).toBeLessThan(32 * MiB)
}, 120_000)

test('past max_stream_bytes mid-stream: 413 and the connection closes, whatever the app answered', async () => {
  const r = await rawUpload('/upload', CEILING / MiB + 1, MiB)
  expect(r.status).toBe(413)
  expect(r.head).toContain('connection: close')
}, 120_000)

test('a second upload over max_streams = 1 is refused 503 + Retry-After; the first still completes', async () => {
  let release!: () => void
  const held = new Promise<void>((ok) => (release = ok))
  let gated = 0
  const first = rawUpload('/upload', 3, 1024, async () => {
    if (gated++ === 0) await held
  })
  // The first upload is admitted once its first chunk has reached the app.
  await Bun.sleep(300)
  const second = await rawUpload('/upload', 1, 1024)
  expect(second.status).toBe(503)
  expect(second.head).toContain('retry-after: 1')
  release()
  const r = await first
  expect(r.status).toBe(200)
  expect(r.body).toContain('"bytes":3072')
}, 60_000)
