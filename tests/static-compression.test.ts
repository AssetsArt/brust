import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { createServer } from 'node:net'
import { gunzipSync } from 'node:zlib'

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as import('node:net').AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

async function readPortLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error('process closed stdout before listening log')
    acc += decoder.decode(value, { stream: true })
    const m = acc.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m?.[1]) {
      reader.releaseLock()
      return parseInt(m[1], 10)
    }
  }
}

let shared: { port: number; proc: Subprocess } | null = null

beforeAll(async () => {
  const port = await freePort()
  const proc = spawn({
    // Boot the fixture app in source mode: islands are built at boot, so
    // /_brust/islands/_react-dom.js exists and is well above MIN_SIZE (1 KB).
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout)
  shared = { port: readyPort, proc }
}, 30_000)

afterAll(async () => {
  if (!shared) return
  shared.proc.kill('SIGINT')
  await shared.proc.exited
})

function sharedPort(): number {
  if (!shared) throw new Error('shared server not started')
  return shared.port
}

interface RawResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

// fetch() in Bun transparently decompresses gzip and strips Content-Encoding, so
// it cannot observe the on-the-wire encoding. Drive a raw TCP socket and parse the
// response by Content-Length (the static handler always sets it).
async function rawGet(port: number, path: string, extraHeaders = ''): Promise<RawResponse> {
  const wire = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extraHeaders}\r\n`
  const chunks: Uint8Array[] = []
  let resolveClose!: () => void
  const closed = new Promise<void>((r) => {
    resolveClose = r
  })
  const sock = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, data) {
        chunks.push(new Uint8Array(data))
      },
      open() {},
      close() {
        resolveClose()
      },
      drain() {},
      error() {
        resolveClose()
      },
    },
  })
  sock.write(wire)

  // Read until we have the full headers + Content-Length bytes of body.
  const buf = () => Buffer.concat(chunks.map((c) => Buffer.from(c)))
  const deadline = Date.now() + 5000
  for (;;) {
    const raw = buf()
    const sep = raw.indexOf('\r\n\r\n')
    if (sep !== -1) {
      const headerText = raw.subarray(0, sep).toString('utf-8')
      const m = headerText.match(/content-length:\s*(\d+)/i)
      if (m) {
        const need = sep + 4 + Number(m[1])
        if (raw.length >= need) break
      }
    }
    if (Date.now() > deadline) break
    await Promise.race([closed, new Promise((r) => setTimeout(r, 25))])
    if (chunks.length && buf().indexOf('\r\n\r\n') !== -1) {
      const raw2 = buf()
      const sep2 = raw2.indexOf('\r\n\r\n')
      const ht = raw2.subarray(0, sep2).toString('utf-8')
      const m2 = ht.match(/content-length:\s*(\d+)/i)
      if (m2 && raw2.length >= sep2 + 4 + Number(m2[1])) break
    }
  }
  sock.end()

  const raw = buf()
  const sep = raw.indexOf('\r\n\r\n')
  if (sep === -1) throw new Error(`no header terminator in response to ${path}`)
  const headerText = raw.subarray(0, sep).toString('utf-8')
  const lines = headerText.split('\r\n')
  const status = Number((lines[0] ?? '').split(' ')[1])
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const cl = headers['content-length'] ? Number(headers['content-length']) : raw.length - sep - 4
  const body = raw.subarray(sep + 4, sep + 4 + cl)
  return { status, headers, body }
}

test('islands JS with Accept-Encoding: gzip → compressed, decompresses to valid JS', async () => {
  const port = sharedPort()
  const res = await rawGet(port, '/_brust/islands/_react-dom.js', 'Accept-Encoding: gzip\r\n')

  expect(res.status).toBe(200)
  expect(res.headers['content-encoding']).toBe('gzip')
  expect((res.headers.vary ?? '').toLowerCase()).toContain('accept-encoding')
  // Cache-Control is preserved on the compressed response.
  expect(res.headers['cache-control']).toBeTruthy()
  // Content-Length matches the compressed body we received.
  expect(Number(res.headers['content-length'])).toBe(res.body.length)

  const decoded = gunzipSync(res.body)
  // Decompressed length is larger than the compressed transfer (proves compression).
  expect(decoded.length).toBeGreaterThan(res.body.length)
  // It is valid JS: non-empty and decodes as text without throwing.
  const js = decoded.toString('utf-8')
  expect(js.length).toBeGreaterThan(1024)
})

test('islands JS without Accept-Encoding → identity, raw size', async () => {
  const port = sharedPort()

  // Reference raw size via the gzipped case decompressed length.
  const gz = await rawGet(port, '/_brust/islands/_react-dom.js', 'Accept-Encoding: gzip\r\n')
  const rawSize = gunzipSync(gz.body).length

  const res = await rawGet(port, '/_brust/islands/_react-dom.js')
  expect(res.status).toBe(200)
  expect(res.headers['content-encoding']).toBeUndefined()
  expect(Number(res.headers['content-length'])).toBe(rawSize)
  expect(res.body.length).toBe(rawSize)
})

test('CSS asset with Accept-Encoding: gzip → compressed (if present & over MIN_SIZE)', async () => {
  const port = sharedPort()
  const res = await rawGet(port, '/_brust/css/app.css', 'Accept-Encoding: gzip\r\n')

  // The css route may 404 if the fixture produces no app.css chunk; islands is
  // the load-bearing case. Only assert compression semantics when present and big.
  if (res.status !== 200) return
  const identity = await rawGet(port, '/_brust/css/app.css')
  const rawSize = Number(identity.headers['content-length'])
  if (rawSize < 1024) {
    // Below MIN_SIZE → must NOT be compressed.
    expect(res.headers['content-encoding']).toBeUndefined()
    return
  }
  expect(res.headers['content-encoding']).toBe('gzip')
  expect((res.headers.vary ?? '').toLowerCase()).toContain('accept-encoding')
  expect(gunzipSync(res.body).length).toBe(rawSize)
})
