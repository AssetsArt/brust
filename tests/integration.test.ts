import { test, expect } from 'bun:test'
import { spawn } from 'bun'

test('serves rendered html via worker pool', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38123',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  const port = await readPortLine(proc.stdout)

  const resp = await fetch(`http://127.0.0.1:${port}/`)
  expect(resp.status).toBe(200)

  const body = await resp.text()
  expect(body).toContain('Hello from Brust')
  expect(body).toMatch(/worker_id=\d+/)

  const ping = await fetch(`http://127.0.0.1:${port}/ping`)
  expect(ping.status).toBe(200)
  expect(ping.headers.get('content-type')).toBe('text/plain')
  expect(await ping.text()).toBe('pong\n')

  proc.kill('SIGINT')
  const exit = await proc.exited
  expect(exit).toBe(0)
}, 15_000)

test('returns 414 when request exceeds MAX_REQUEST_BYTES', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38124',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  const port = await readPortLine(proc.stdout)

  // Build a request whose request-line alone exceeds 16 KB.
  // 17 KB of path bytes guarantees we cross the cap before \r\n\r\n is seen.
  const longPath = '/' + 'a'.repeat(17 * 1024)
  const wire = `GET ${longPath} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`

  // We use a raw TCP socket because fetch() refuses to send a URL that long.
  // Bun.connect() in 1.4.x does not expose a readable stream; collect bytes
  // via the data() handler instead and await close() to know when the server
  // has finished writing.
  const chunks: Uint8Array[] = []
  let resolveClose!: () => void
  const closed = new Promise<void>((r) => { resolveClose = r })

  const sock = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, data) { chunks.push(new Uint8Array(data)) },
      open() {},
      close() { resolveClose() },
      drain() {},
      error() { resolveClose() },
    },
  })

  sock.write(wire)
  // Wait for the server to write its 414 (or close silently). 1 s is overkill
  // on localhost; if the server hasn't closed by then, something is wrong.
  await Promise.race([
    closed,
    new Promise((r) => setTimeout(r, 1000)),
  ])
  sock.end()

  const received = new TextDecoder().decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c)))
  )

  // The server must have answered 414, not closed silently.
  try {
    expect(received).toContain('414')
    expect(received.toLowerCase()).toContain('uri too long')
    expect(received).toContain('Connection: close')
  } finally {
    proc.kill('SIGINT')
  }
  const exit = await proc.exited
  expect(exit).toBe(0)
}, 15_000)

async function readPortLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error('process closed stdout before listening log')
    acc += decoder.decode(value, { stream: true })
    const m = acc.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m) {
      reader.releaseLock()
      return parseInt(m[1], 10)
    }
  }
}
