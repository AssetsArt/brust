import { test, expect } from 'bun:test'
import { spawn } from 'bun'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('serves rendered html via worker pool', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
      cmd: ['bun', 'run', join(projectRoot, 'tests/fixtures/app/index.ts')],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    expect(body).not.toContain('data-brust-island=')
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    expect(body).toContain('invalid request body')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: args not an array → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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

test('action endpoint: undefined return → 200 with empty body', async () => {
  // pingAction returns void → JS terminal sends body: '' with status 200.
  // Verifies the wire roundtrip handles Content-Length: 0 cleanly.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38184', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/pingAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(resp.headers.get('content-length')).toBe('0')
    expect(await resp.text()).toBe('')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: Content-Length > 256 KB → 413', async () => {
  // Server rejects oversized bodies BEFORE reading them: parse_content_length
  // returns > MAX_ACTION_BODY_BYTES (256 KB) and writes 413 immediately.
  // Use a raw socket so we can claim a large Content-Length without actually
  // sending the bytes — the server should 413 from headers alone.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38185', RUST_LOG: 'brust=warn' },
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
    sock.write(
      'POST /_brust/action/createNote HTTP/1.1\r\n' +
      'Host: x\r\n' +
      'Content-Length: 300000\r\n' +
      '\r\n',
    )
    await Promise.race([
      closed,
      new Promise<void>((r) => setTimeout(r, 1000)),
    ])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    expect(combined.split('\r\n')[0]).toContain('413')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action middleware: short-circuits without cookie', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
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

test('action endpoint: form-urlencoded body → FormData arg', async () => {
  // pingAction takes no args; the framework parses the form-urlencoded body
  // into FormData and spreads [FormData] into pingAction, which ignores its
  // args and returns void. Confirms the form-urlencoded path reaches the handler.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38186', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/pingAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'unused=field',
    })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: multipart body → FormData with File', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38187', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const fd = new FormData()
    fd.append('file', new File(['hello'], 'greeting.txt', { type: 'text/plain' }))
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/uploadAvatar`, {
      method: 'POST',
      body: fd,
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { name: string, size: number }
    expect(body.name).toBe('greeting.txt')
    expect(body.size).toBe(5)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: unsupported Content-Type → 415', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38188', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: '<x/>',
    })
    expect(resp.status).toBe(415)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: malformed multipart body → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38189', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/uploadAvatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=does-not-match' },
      body: 'not-actually-multipart',
    })
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).toContain('invalid request body')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: JSON path still works after wire-format refactor', async () => {
  // Sanity test — duplicates the createNote happy path from session 5 but
  // proves the body_text refactor preserved JSON semantics.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38190', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['hello after refactor']),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { id: string }
    expect(body.id).toMatch(/^n-\d+$/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: middleware short-circuits a multipart action', async () => {
  // deleteNote is JSON-shape with requireUser middleware. Posting multipart
  // to it without a cookie should still 401 — middleware runs before body
  // parsing reaches the handler.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38191', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const fd = new FormData()
    fd.append('noteId', 'n-1')
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/deleteNote`, {
      method: 'POST',
      body: fd,
    })
    expect(resp.status).toBe(401)
    expect(await resp.text()).toBe('login required')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: index route renders parent layout + dashboard', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38192', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
      headers: { 'cookie': 'user=alice' },
    })
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('AdminLayout')
    expect(body).toContain('AdminDashboard')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: child path inherits parent middleware (401 without cookie)', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38193', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin/users`)
    expect(resp.status).toBe(401)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: param child renders with id from path', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38194', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin/users/42`, {
      headers: { 'cookie': 'user=alice' },
    })
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('AdminLayout')
    expect(body).toContain('AdminUserDetail')
    // React 18 SSR may insert comment markers between text nodes, so
    // grep for the id value itself (42), not the literal 'id=42'.
    expect(body).toMatch(/id\D*42/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: parent errorBoundary catches child throw', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38195', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin/users/throw`, {
      headers: { 'cookie': 'user=alice' },
    })
    expect(resp.status).toBe(500)
    const body = await resp.text()
    expect(body).toContain('AdminErrorBoundary')
    expect(body).toContain('intentional admin child throw')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: flat route still renders (no regression)', async () => {
  // Sanity test: the existing flat `/` route still works after the
  // flatten + chain-walker refactor.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38196', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('Hello from Brust')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

async function mcpRequest(port: number, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: resp.status, body: await resp.json() }
}

test('mcp: initialize returns server capabilities', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38197', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { status, body } = await mcpRequest(port, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' },
    })
    expect(status).toBe(200)
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.serverInfo.name).toBe('brust')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.capabilities.resources).toBeDefined()
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/list returns all scanned actions', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38198', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/list')
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toContain('createNote')
    expect(names).toContain('whoAmI')
    expect(names).toContain('deleteNote')
    expect(names).toContain('pingAction')
    expect(names).toContain('uploadAvatar')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/call createNote happy path', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38199', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'createNote',
      arguments: { text: 'hello via mcp' },
    })
    expect(body.result.isError).toBe(false)
    const result = JSON.parse(body.result.content[0].text)
    expect(result.id).toMatch(/^n-\d+$/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/call middleware-gated action without cookie → isError', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38200', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'deleteNote',
      arguments: { noteId: 'n-1' },
    })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('login required')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/call with cookie passes middleware', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38201', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'deleteNote',
      arguments: { noteId: 'n-1' },
    }, { 'cookie': 'user=alice' })
    expect(body.result.isError).toBe(false)
    const result = JSON.parse(body.result.content[0].text)
    expect(result.ok).toBe(true)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: resources/list returns loaders', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38202', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'resources/list')
    const uris = body.result.resources.map((r: any) => r.uri)
    expect(uris).toContain('brust:///blog/{slug}')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: resources/read fetches loader output', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38203', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'resources/read', { uri: 'brust:///blog/hello' })
    expect(body.result.contents).toHaveLength(1)
    const content = body.result.contents[0]
    expect(content.uri).toBe('brust:///blog/hello')
    const data = JSON.parse(content.text)
    expect(data.title).toBe('Post: hello')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: prompts/list returns empty', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38204', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'prompts/list')
    expect(body.result.prompts).toEqual([])
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: unknown method returns -32601', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38205', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'nonexistentMethod')
    expect(body.error.code).toBe(-32601)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
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

// ----- SSE integration tests -----

async function openSseConn(port: number, path: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController()
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...headers },
    signal: ctrl.signal,
  })
  return { resp, ctrl }
}

const _TICK = Symbol('tick')

async function readAllText(resp: Response, maxBytes = 4096, maxMs = 2000): Promise<string> {
  const reader = resp.body!.getReader()
  const chunks: Uint8Array[] = []
  const start = Date.now()
  let total = 0
  while (Date.now() - start < maxMs) {
    const r = await Promise.race([
      reader.read(),
      new Promise<typeof _TICK>((resolve) =>
        setTimeout(() => resolve(_TICK), 100)),
    ])
    // _TICK means the 100ms poll expired but budget remains — keep looping.
    if (r === _TICK) continue
    // Real reader result: done=true means stream closed.
    if (r.done) break
    if (r.value) {
      chunks.push(r.value)
      total += r.value.byteLength
      if (total >= maxBytes) break
    }
  }
  reader.cancel().catch(() => {})
  // Concatenate chunks then decode
  let bufLen = 0
  for (const c of chunks) bufLen += c.byteLength
  const all = new Uint8Array(bufLen)
  let off = 0
  for (const c of chunks) { all.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(all)
}

const SSE_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',         // critical — see SSE spec §8
  RUST_LOG: 'brust=warn',
})

test('sse: 3 data frames in order then close', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: SSE_ENV('38210'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { resp } = await openSseConn(port, '/sse-counter')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/event-stream')
    const text = await readAllText(resp)
    expect(text).toContain('data: 1\n\n')
    expect(text).toContain('data: 2\n\n')
    expect(text).toContain('data: 3\n\n')
    expect(text.indexOf('data: 1')).toBeLessThan(text.indexOf('data: 2'))
    expect(text.indexOf('data: 2')).toBeLessThan(text.indexOf('data: 3'))
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('sse: heartbeat ping arrives on idle stream', async () => {
  // /sse-idle uses sseOptions.heartbeatMs=100 so we don't wait 15s for
  // the default heartbeat. Stream never enqueues data, so any bytes
  // observed must be the framework's `: ping\n\n` heartbeat.
  // Bun's fetch API buffers SSE body chunks until the stream closes, so
  // we use a raw TCP socket (same pattern as the 414/411 tests) to observe
  // frames as they arrive from the wire.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: SSE_ENV('38215'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const rawChunks: Uint8Array[] = []
    let resolveClose!: () => void
    const closed = new Promise<void>((r) => { resolveClose = r })
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(_s, d) { rawChunks.push(new Uint8Array(d)) },
        open(s) {
          s.write('GET /sse-idle HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n')
        },
        close() { resolveClose() },
        drain() {},
        error() { resolveClose() },
      },
    })
    // Wait 350ms — at 100ms heartbeat interval we expect 2-3 pings.
    await Promise.race([closed, new Promise((r) => setTimeout(r, 350))])
    sock.end()
    const raw = Buffer.concat(rawChunks.map((c) => Buffer.from(c))).toString('utf-8')
    // Must contain SSE response headers + at least one heartbeat frame.
    expect(raw).toContain('text/event-stream')
    expect(raw).toContain(': ping')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('sse: client disconnect fires req.signal abort within 1s', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: SSE_ENV('38211'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { resp, ctrl } = await openSseConn(port, '/sse-counter')
    expect(resp.status).toBe(200)
    ctrl.abort()
    await new Promise((r) => setTimeout(r, 1000))

    // BRUST_WORKERS=1 ensures the probe action lands on the same JS
    // context that ran the SSE handler — so __lastSseAbort is set.
    const probe = await fetch(`http://127.0.0.1:${port}/_brust/action/lastSseAbort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    expect(probe.status).toBe(200)
    const { ts } = await probe.json() as { ts: number }
    expect(ts).toBeGreaterThan(0)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('sse: middleware reject returns 401 + non-SSE content-type', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: SSE_ENV('38212'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { resp } = await openSseConn(port, '/sse-gated')
    expect(resp.status).toBe(401)
    expect(resp.headers.get('content-type') ?? '').not.toContain('text/event-stream')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('sse: middleware pass with cookie streams normally', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: SSE_ENV('38213'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { resp } = await openSseConn(port, '/sse-gated', { cookie: 'user=alice' })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/event-stream')
    const text = await readAllText(resp)
    expect(text).toContain('data: 1\n\n')
    expect(text).toContain('data: 3\n\n')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('sse: POST to an SSE route returns 405', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: SSE_ENV('38214'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/sse-counter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    })
    expect(resp.status).toBe(405)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

// ----- WS integration tests -----

function makeWsClient(port: number, path: string, subprotocols?: string[]): { ws: WebSocket, opened: Promise<void>, closed: Promise<{ code: number, reason: string }>, messages: Promise<(string | ArrayBuffer)[]> } {
  const url = `ws://127.0.0.1:${port}${path}`
  const ws = subprotocols ? new WebSocket(url, subprotocols) : new WebSocket(url)
  let resolveOpen: () => void
  let resolveClose: (v: { code: number, reason: string }) => void
  let resolveMessages: (v: (string | ArrayBuffer)[]) => void
  const opened = new Promise<void>((r) => { resolveOpen = r })
  const closed = new Promise<{ code: number, reason: string }>((r) => { resolveClose = r })
  const msgs: (string | ArrayBuffer)[] = []
  const messages = new Promise<(string | ArrayBuffer)[]>((r) => { resolveMessages = r })
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { resolveOpen() }
  ws.onmessage = (e) => { msgs.push(e.data as string | ArrayBuffer) }
  ws.onclose = (e) => { resolveMessages(msgs); resolveClose({ code: e.code, reason: e.reason }) }
  ws.onerror = () => { /* swallow; close will fire */ }
  return { ws, opened, closed, messages }
}

const WS_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',         // critical — colocate handler + probe action
  RUST_LOG: 'brust=warn',
})

test('ws: handshake + echo', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38220'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.send('hello')
    await new Promise((r) => setTimeout(r, 200))
    c.ws.close()
    const got = await c.messages
    expect(got).toContain('hello')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: binary frame round-trip', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38221'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.send(new Uint8Array([1, 2, 3]).buffer)
    await new Promise((r) => setTimeout(r, 200))
    c.ws.close()
    const got = await c.messages
    expect(got.length).toBeGreaterThan(0)
    expect(got[0]).toBeInstanceOf(ArrayBuffer)
    const bytes = new Uint8Array(got[0] as ArrayBuffer)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: server-initiated close fires client onclose with code 4000', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38222'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/server-close')
    const closed = await c.closed
    expect(closed.code).toBe(4000)
    expect(closed.reason).toBe('bye')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: middleware reject returns 401 + no upgrade', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38223'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/ws/gated`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    })
    expect(resp.status).toBe(401)
    expect(resp.headers.get('content-type') ?? '').not.toContain('websocket')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: middleware pass with cookie completes handshake + echo', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38224'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/gated`, { headers: { cookie: 'user=alice' } } as any)
    const got: string[] = []
    let closed = false
    ws.onopen = () => { ws.send('hi') }
    ws.onmessage = (e) => { got.push(e.data as string); ws.close() }
    ws.onclose = () => { closed = true }
    await new Promise((r) => setTimeout(r, 1500))
    expect(got).toContain('hi')
    expect(closed).toBe(true)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: subprotocol negotiation picks first match in route order', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38225'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // route declares ['chat.v2', 'chat.v1']
    // client requests ['chat.v0', 'chat.v1']
    // chat.v1 is the first route-declared subprotocol that also appears
    // in the client list → server picks chat.v1.
    const c = makeWsClient(port, '/ws/protocols', ['chat.v0', 'chat.v1'])
    await c.opened
    expect(c.ws.protocol).toBe('chat.v1')
    c.ws.close()
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: client clean close fires server on_close with 1000', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: WS_ENV('38226'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.close()
    await new Promise((r) => setTimeout(r, 500))

    // BRUST_WORKERS=1 ensures the probe action lands on the same JS
    // context that ran the WS handler.
    const probe = await fetch(`http://127.0.0.1:${port}/_brust/action/lastWsClose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    expect(probe.status).toBe(200)
    const { code } = await probe.json() as { code: number, reason: string }
    expect(code).toBe(1000)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

// ----- HTML Streaming integration tests -----

const STREAM_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',
  RUST_LOG: 'brust=warn',
})

test('streaming: single-chunk regression — / uses Content-Length, not chunked', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: STREAM_ENV('38230'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).not.toBeNull()
    expect(resp.headers.get('transfer-encoding')).toBeNull()
    const body = await resp.text()
    expect(body.length).toBeGreaterThan(0)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('streaming: /slow-suspense uses Transfer-Encoding: chunked + shell-before-resolved', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: STREAM_ENV('38231'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/slow-suspense`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('transfer-encoding')).toBe('chunked')
    expect(resp.headers.get('content-length')).toBeNull()
    // Read the body progressively — assert spinner arrives before resolved content
    // (proves streaming, not buffered).
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    let sawSpinnerBeforeResolved = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      if (!sawSpinnerBeforeResolved
          && acc.includes('loading...')
          && !acc.includes('Resolved after 200ms')) {
        sawSpinnerBeforeResolved = true
      }
    }
    expect(sawSpinnerBeforeResolved).toBe(true)
    expect(acc).toContain('Resolved after 200ms')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('streaming: mid-stream disconnect — second request to same worker still succeeds', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: STREAM_ENV('38232'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // First request: open the chunked stream, then abort mid-flight.
    const ac = new AbortController()
    const first = fetch(`http://127.0.0.1:${port}/slow-suspense`, { signal: ac.signal })
      .catch((e: Error) => ({ aborted: true, msg: e.message }))
    // Give the server time to commit headers + first chunk before we abort.
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await first  // resolves to { aborted: true } via the .catch

    // Wait a beat for slot Drop guard to fire.
    await new Promise((r) => setTimeout(r, 200))

    // Second request to the SAME worker (BRUST_WORKERS=1) MUST succeed —
    // proves RenderSlotGuard cleared the leaked slot on the cancelled request.
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body.length).toBeGreaterThan(0)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

// ----- Navigation interceptor integration tests -----

const NAV_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',
  RUST_LOG: 'brust=warn',
})

test('nav: /_brust/page/blog/x returns JSON {html, title} with <main> inner only', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38240'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/blog/welcome`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type') ?? '').toContain('application/json')
    const body = await resp.json() as { html: string; title: string }
    expect(typeof body.html).toBe('string')
    expect(typeof body.title).toBe('string')
    // <main> chrome excluded — no header/footer literals
    expect(body.html).not.toContain('<header')
    expect(body.html).not.toContain('<footer')
    // Page-specific content present
    expect(body.html).toContain('Post: welcome')
    // Title carries the page name
    expect(body.title).toContain('Post: welcome')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('nav: /_brust/page/<unknown> returns 404 with JSON error envelope', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38241'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/this/path/does/not/exist`)
    expect(resp.status).toBe(404)
    expect(resp.headers.get('content-type') ?? '').toContain('application/json')
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('not found')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('nav: page without <main> falls back to shipping full HTML in html field', async () => {
  // The fixture's /cache-test route renders CacheTest, which is a bare
  // fragment (<h1>CacheTest</h1><p>render=N</p>) with no <main> wrapper.
  // The navigation branch detects the missing <main> and ships the full
  // rendered HTML instead, so the client interceptor fires its no-main
  // fallback. (/crash was the plan's original choice but renderToString
  // does not honour errorBoundary — it propagates the throw as a 500.)
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38242'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/cache-test`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type') ?? '').toContain('application/json')
    const body = await resp.json() as { html: string; title: string }
    // Full HTML fallback — no <main> in the response, but the
    // CacheTest content is present.
    expect(body.html).not.toContain('<main')
    expect(body.html).toContain('CacheTest')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('nav: /_brust/page/<protected> without cookie returns middleware verdict (401)', async () => {
  // /admin (index) is guarded by authRequired middleware on the parent layout
  // (no cookie → 401). The navigation endpoint must honour middleware
  // short-circuits, otherwise it would leak guarded content via the JSON envelope.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38243'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/admin`)
    // Middleware short-circuits with 401 before render happens — the client
    // will treat any non-2xx as a fallback trigger (full reload).
    expect(resp.status).toBe(401)
    // The response body should NOT contain the rendered admin dashboard.
    const body = await resp.text()
    expect(body).not.toContain('Admin Dashboard')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)
