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
    // errorBoundary returns 500 — the worker encodes the status into the
    // meta JSON envelope (`{status, headers?}`) at the head of the SAB;
    // Rust parses the meta before calling build_response.
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

test('cache stats endpoint reflects hits and misses', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38151',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Initially zero.
    const r0 = await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    expect(r0.status).toBe(200)
    expect(r0.headers.get('content-type')).toBe('application/json')
    const s0 = await r0.json() as { hits: number, misses: number, len: number, capacity: number }
    expect(s0.hits).toBe(0)
    expect(s0.misses).toBe(0)
    expect(s0.len).toBe(0)
    expect(s0.capacity).toBe(1000)

    // First /cache-test = miss + insert.
    await fetch(`http://127.0.0.1:${port}/cache-test`)
    // Second = hit.
    await fetch(`http://127.0.0.1:${port}/cache-test`)

    const r1 = await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    const s1 = await r1.json() as { hits: number, misses: number, len: number, capacity: number }
    expect(s1.hits).toBeGreaterThanOrEqual(1)
    expect(s1.misses).toBeGreaterThanOrEqual(1)
    expect(s1.len).toBeGreaterThanOrEqual(1)
    expect(s1.capacity).toBe(1000)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('middleware short-circuits with 401 when cookie missing', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38161', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/protected`)
    expect(r.status).toBe(401)
    expect(await r.text()).toBe('unauthorised')
    expect(r.headers.get('www-authenticate')).toBe('Cookie')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('middleware lets request through when cookie present + req.cookies reaches component', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38162', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      headers: { cookie: 'user=alice; sid=xyz' },
    })
    expect(r.status).toBe(200)
    // React 18 inserts <!-- --> between adjacent text nodes (text literal + {var}),
    // so strip those before the substring check.
    const body = (await r.text()).replace(/<!--\s*-->/g, '')
    expect(body).toContain('signed in as alice')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('middleware injects x-render-ms response header + req.search reaches component', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38163', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/with-header?name=brust`)
    expect(r.status).toBe(200)
    const ms = r.headers.get('x-render-ms')
    expect(ms).not.toBeNull()
    expect(Number(ms)).toBeGreaterThanOrEqual(0)
    // React 18 inserts <!-- --> between adjacent text nodes (text literal + {var}),
    // so strip those before the substring check.
    const body = (await r.text()).replace(/<!--\s*-->/g, '')
    expect(body).toContain('Hello, brust')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('errorBoundary 500 path does not pick up middleware-only headers', async () => {
  // /crash has no middleware; verifies that the chain-less terminal path
  // still flows status 500 through meta.status (not the legacy 2-byte prefix)
  // AND that no rogue middleware headers (e.g. x-render-ms from a global
  // middleware that doesn't exist yet) leak into the response. Complements
  // the existing /crash test which covers boundary HTML content.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38164', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/crash`)
    expect(r.status).toBe(500)
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(r.headers.get('x-render-ms')).toBeNull()
    const body = await r.text()
    expect(body).toContain('CrashBoundary')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate by path drops a cached entry', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38171',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Warm the cache for /cache-test (CacheTest's body contains a counter
    // that changes on re-render; cache hit returns identical bytes).
    const first = await fetch(`http://127.0.0.1:${port}/cache-test`)
    const firstBody = await first.text()
    expect(first.status).toBe(200)

    // Hit again → cache hit → identical body.
    const cached = await fetch(`http://127.0.0.1:${port}/cache-test`)
    expect(await cached.text()).toBe(firstBody)

    // Invalidate just that path.
    const inv = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?path=/cache-test`, {
      method: 'POST',
    })
    expect(inv.status).toBe(200)
    expect(inv.headers.get('content-type')).toBe('application/json')
    const body = await inv.json() as { removed: number }
    expect(body.removed).toBeGreaterThanOrEqual(1)

    // Next request re-renders (counter advances) → body must differ from firstBody.
    const reRender = await fetch(`http://127.0.0.1:${port}/cache-test`)
    expect(reRender.status).toBe(200)
    expect(await reRender.text()).not.toBe(firstBody)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate all clears every entry + reports correct removed count', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38172',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Warm /cache-test (only cached route in the example).
    await fetch(`http://127.0.0.1:${port}/cache-test`)
    const beforeStats = await (await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)).json() as {
      hits: number, misses: number, len: number, capacity: number,
    }
    expect(beforeStats.len).toBeGreaterThanOrEqual(1)

    const inv = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?all=1`, {
      method: 'POST',
    })
    expect(inv.status).toBe(200)
    const body = await inv.json() as { removed: number }
    expect(body.removed).toBe(beforeStats.len)

    const afterStats = await (await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)).json() as {
      hits: number, misses: number, len: number,
    }
    expect(afterStats.len).toBe(0)
    // Counters are preserved (hits/misses survive clear).
    expect(afterStats.hits).toBe(beforeStats.hits)
    expect(afterStats.misses).toBe(beforeStats.misses)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate endpoint rejects GET and unsupported queries', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38173',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // GET on the invalidate endpoint must not work (POST-only).
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?path=/x`)
    expect(wrongMethod.status).toBe(405)

    // POST without path or all=1 returns 400.
    const missingParams = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate`, {
      method: 'POST',
    })
    expect(missingParams.status).toBe(400)
    const body = await missingParams.json() as { error: string }
    expect(body.error).toContain('missing')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('island marker + importmap injected when route uses <Island>', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38181', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`)
    expect(r.status).toBe(200)
    const body = await r.text()
    // Marker present, with id + JSON props + hydrate trigger.
    expect(body).toContain('data-brust-island="Counter"')
    expect(body).toContain('data-brust-hydrate="load"')
    expect(body).toContain('data-brust-props="{')
    // Importmap + bootstrap injected.
    expect(body).toContain('<script type="importmap">')
    expect(body).toContain('"/_brust/islands/_react.js"')
    // react/jsx-runtime also maps to _react.js (combined chunk).
    expect(body).toContain('"react/jsx-runtime":"/_brust/islands/_react.js"')
    expect(body).toContain('"/_brust/islands/_react-dom.js"')
    expect(body).toContain('src="/_brust/islands/_bootstrap.js"')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 30_000)

test('island chunk + bootstrap served at /_brust/islands/<file>', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38182', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    for (const file of ['Counter.js', '_bootstrap.js', '_react.js', '_react-dom.js']) {
      const r = await fetch(`http://127.0.0.1:${port}/_brust/islands/${file}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
      expect(r.headers.get('cache-control')).toBe('public, max-age=3600')
      const body = await r.text()
      expect(body.length).toBeGreaterThan(0)
    }

    // 404 + path-traversal safety.
    const missing = await fetch(`http://127.0.0.1:${port}/_brust/islands/missing.js`)
    expect(missing.status).toBe(404)

    const traversal = await fetch(`http://127.0.0.1:${port}/_brust/islands/..%2Fetc%2Fpasswd.js`)
    expect(traversal.status).toBe(404)

    const noExt = await fetch(`http://127.0.0.1:${port}/_brust/islands/Counter`)
    expect(noExt.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 30_000)

test('routes without <Island> ship no importmap or bootstrap', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38183', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // /blog/{slug} doesn't use <Island>.
    const r = await fetch(`http://127.0.0.1:${port}/blog/test-slug`)
    expect(r.status).toBe(200)
    const body = await r.text()
    expect(body).not.toContain('data-brust-island')
    expect(body).not.toContain('<script type="importmap">')
    expect(body).not.toContain('_bootstrap.js')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 30_000)

test('action endpoint: happy path returns JSON', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38150', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['hi there']),
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('application/json')
    const body = await resp.json() as { id: string }
    expect(body.id).toMatch(/^n-\d+$/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: malformed JSON args → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38157', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(resp.status).toBe(400)
    const body = await resp.text()
    expect(body).toContain('invalid args JSON')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: args not an array → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38152', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(resp.status).toBe(400)
    const body = await resp.text()
    expect(body).toContain('JSON array')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: unknown id → 404', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38153', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    expect(resp.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: GET → 405', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38154', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`)
    expect(resp.status).toBe(405)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: id with bad charset → 404', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38155', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Dot in the id should be rejected by is_safe_action_id.
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/bad.id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    expect(resp.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: missing Content-Length → 411', async () => {
  // fetch always sets Content-Length, so use a raw socket like the 414 test.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38156', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const chunks: Uint8Array[] = []
    let resolveClose!: () => void
    const closed = new Promise<void>((r) => { resolveClose = r })
    const sock = await Bun.connect({
      hostname: '127.0.0.1', port,
      socket: {
        data(_s, data) { chunks.push(new Uint8Array(data)) },
        open() {}, close() { resolveClose() }, drain() {}, error() { resolveClose() },
      },
    })
    // Hand-crafted request: no Content-Length, no body.
    sock.write('POST /_brust/action/createNote HTTP/1.1\r\nHost: x\r\n\r\n')
    await Promise.race([
      closed,
      new Promise<void>((r) => setTimeout(r, 1000)),
    ])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    expect(combined.split('\r\n')[0]).toContain('411')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action middleware: short-circuits without cookie', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38158', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/deleteNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['n-123']),
    })
    expect(resp.status).toBe(401)
    expect(await resp.text()).toBe('login required')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action middleware: passes through with cookie', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38159', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/deleteNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': 'user=alice' },
      body: JSON.stringify(['n-123']),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action-calling island page renders marker + importmap + bootstrap', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38170', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/note`)).text()
    // Marker for the NoteForm island
    expect(html).toContain('data-brust-island="NoteForm"')
    expect(html).toContain('data-brust-hydrate="load"')
    // Importmap + bootstrap script tags
    expect(html).toContain('<script type="importmap">')
    expect(html).toContain('/_brust/islands/_bootstrap.js')

    // The NoteForm.js chunk is served from /_brust/islands.
    const chunk = await fetch(`http://127.0.0.1:${port}/_brust/islands/NoteForm.js`)
    expect(chunk.status).toBe(200)
    expect(chunk.headers.get('content-type')).toContain('javascript')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 20_000)

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
