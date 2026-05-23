import { test, expect } from 'bun:test'
import { spawn } from 'bun'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('routes /blog/:slug renders BlogPost with the slug param', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38131', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/blog/hello-world`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('BlogPost')
    expect(body).toContain('hello-world')             // the slug appears in the rendered HTML
    expect(body).toContain('Post: hello-world')       // the loader-produced title appears
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('unknown path returns 404', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38132', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/no/such/path`)
    expect(resp.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('errorBoundary renders when a route component throws', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38133', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/crash`)
    // errorBoundary now returns 500 — the worker encodes the status in the
    // 2-byte SAB prefix that Rust reads before building the response.
    expect(resp.status).toBe(500)
    const body = await resp.text()
    expect(body).toContain('CrashBoundary')
    expect(body).toContain('intentional crash for test')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('reads port and workers from brust.toml at cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-toml-'))
  try {
    const projectRoot = process.cwd()
    const tomlBody = [
      '[server]',
      'port = 38125',
      '',
      '[workers]',
      'count = 2',
      '',
    ].join('\n')
    await writeFile(join(dir, 'brust.toml'), tomlBody)

    const proc = spawn({
      cmd: ['bun', 'run', join(projectRoot, 'example/hello-world/index.ts')],
      cwd: dir,
      env: {
        // Strip env overrides so TOML is the only source of truth.
        ...Object.fromEntries(Object.entries(process.env).filter(
          ([k]) => k !== 'BRUST_PORT' && k !== 'BRUST_WORKERS',
        )),
        RUST_LOG: 'brust=info',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    })

    const port = await readPortLine(proc.stdout)
    try {
      expect(port).toBe(38125)
      const resp = await fetch(`http://127.0.0.1:${port}/`)
      expect(resp.status).toBe(200)
      expect(await resp.text()).toContain('Hello from Brust')
    } finally {
      proc.kill('SIGINT')
      const exit = await proc.exited
      expect(exit).toBe(0)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

test('cache-test route returns same body on second hit (cache hit)', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38141',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const first  = await fetch(`http://127.0.0.1:${port}/cache-test`)
    const firstBody = await first.text()
    expect(first.status).toBe(200)
    expect(firstBody).toMatch(/render=\d+/)

    const second = await fetch(`http://127.0.0.1:${port}/cache-test`)
    const secondBody = await second.text()
    expect(second.status).toBe(200)
    expect(secondBody).toBe(firstBody)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
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
