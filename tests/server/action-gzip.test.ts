// F547: a buffered action reply is gzip-compressed for a client that accepts it, the way pages are. ~19 KB of JS comes
// back `Content-Encoding: gzip` with `Vary: Accept-Encoding` (merged into the app's own `Vary`), a strong `ETag`
// dropped, and decodes to the same bytes; `Cache-Control: no-transform`, a short body, a type that never compresses, a
// reply the app already encoded, and a client that does not offer gzip all stay identity. Read off a raw socket
// because `fetch` decodes and hides the framing. Run alone: `bun test --timeout 180000 tests/server/action-gzip.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/action-gzip')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let host = ''
let port = 0

const shellEnv = () => {
  const { NODE_ENV: _n, ...rest } = process.env
  return { ...rest, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', CI: '' }
}

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  let log = ''
  const dec = new TextDecoder()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  void (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(c, { stream: true }) })()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust exited before ready:\n${out}\n${log}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  const addr = /listening on (\S+)/.exec(out)![1]
  ;[host, port] = [addr.slice(0, addr.lastIndexOf(':')).replace(/^\[|\]$/g, ''), Number(addr.slice(addr.lastIndexOf(':') + 1))]
}, 180_000)

afterAll(async () => {
  proc.kill('SIGINT')
  if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

type Raw = { status: number; headers: Map<string, string[]>; body: Buffer }

/** One HTTP/1.1 GET over a socket, `Connection: close`: the bytes as sent (no decoding, no header folding). */
function raw(path: string, acceptEncoding?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const s = connect({ host, port }, () => {
      const ae = acceptEncoding === undefined ? '' : `Accept-Encoding: ${acceptEncoding}\r\n`
      s.write(`GET /api${path} HTTP/1.1\r\nHost: ${host}\r\n${ae}Connection: close\r\n\r\n`)
    })
    s.on('data', (c) => chunks.push(c as Buffer))
    s.on('error', reject)
    s.on('close', () => {
      const all = Buffer.concat(chunks)
      const cut = all.indexOf('\r\n\r\n')
      const [line, ...rest] = all.subarray(0, cut).toString('latin1').split('\r\n')
      const headers = new Map<string, string[]>()
      for (const l of rest) {
        const i = l.indexOf(':')
        const k = l.slice(0, i).toLowerCase()
        headers.set(k, [...(headers.get(k) ?? []), l.slice(i + 1).trim()])
      }
      let body = all.subarray(cut + 4)
      if (headers.get('transfer-encoding')?.[0] === 'chunked') throw new Error('unexpected chunked reply')
      const len = headers.get('content-length')?.[0]
      if (len !== undefined) body = body.subarray(0, Number(len))
      resolve({ status: Number(line.split(' ')[1]), headers, body })
    })
  })
}

const one = (r: Raw, name: string) => r.headers.get(name)?.join(', ')
const expected = Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i} * 2; // module line ${i}\n`).join('')

test('19 KB of JS comes back gzip, Vary merged, strong ETag dropped, and decodes to the same bytes', async () => {
  const r = await raw('/js', 'gzip, br')
  expect(r.status).toBe(200)
  expect(one(r, 'content-encoding')).toBe('gzip')
  expect(one(r, 'vary')).toBe('Origin, Accept-Encoding')
  expect(r.headers.has('etag')).toBe(false)
  expect(one(r, 'content-length')).toBe(String(r.body.length))
  expect(expected.length).toBeGreaterThan(19 * 1024)
  expect(r.body.length).toBeLessThan(expected.length / 2)
  expect(gunzipSync(r.body).toString()).toBe(expected)
})

test('fetch (which decodes) gets the same text', async () => {
  const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/api/js`)
  expect(await r.text()).toBe(expected)
})

test('a client that does not offer gzip gets the identity bytes, the strong ETag, and Vary: Accept-Encoding all the same', async () => {
  for (const ae of [undefined, 'identity', 'br', 'gzip;q=0']) {
    const r = await raw('/js', ae)
    expect(r.headers.has('content-encoding')).toBe(false)
    expect(one(r, 'vary')).toBe('Origin, Accept-Encoding')
    expect(one(r, 'etag')).toBe('"v1"')
    expect(r.body.toString()).toBe(expected)
  }
})

test('no-transform, a short body, a type that never compresses and an encoded reply all stay identity', async () => {
  for (const [path, body] of [['/js-nt', expected], ['/short', 'const a = 1'], ['/image', expected], ['/encoded', expected]] as const) {
    const r = await raw(path, 'gzip')
    expect(r.status).toBe(200)
    expect(one(r, 'content-encoding') ?? 'identity').not.toBe('gzip')
    expect(one(r, 'vary') ?? '').not.toContain('Accept-Encoding')
    expect(r.body.toString()).toBe(body)
  }
  expect(one(await raw('/js-nt', 'gzip'), 'cache-control')).toBe('private, no-transform')
})
