import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

async function startServer(
  opts: { workers?: string; rustLog?: string; cmd?: string[]; env?: Record<string, string> } = {},
) {
  const port = await freePort()
  const proc = spawn({
    cmd: opts.cmd ?? ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: String(port),
      BRUST_WORKERS: opts.workers ?? '1',
      RUST_LOG: opts.rustLog ?? 'brust=info',
      ...(opts.env ?? {}),
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout)
  return {
    port: readyPort,
    proc,
    async stop() {
      proc.kill('SIGINT')
      return await proc.exited
    },
  }
}

// One server shared by all stateless, read-only, default-config tests (see
// docs/superpowers/specs/2026-05-31-integration-shared-server-design.md). Cuts
// the redundant per-test boots. Stateful/special tests still use startServer().
let shared: { port: number; proc: Subprocess } | null = null

beforeAll(async () => {
  const port = await freePort()
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout)
  shared = { port: readyPort, proc }
}, 30_000) // boot includes the island chunk build (Bun.build ×3+N); cold CI needs headroom

afterAll(async () => {
  if (!shared) return
  shared.proc.kill('SIGINT')
  // Single place that asserts clean shutdown for the shared server.
  expect(await shared.proc.exited).toBe(0)
})

/** Port of the shared server. ONLY for stateless, read-only, default-config
 * tests. Denylist: never request a cacheable route via a CACHING path on the
 * shared server — `GET /cache-test` directly (mutates a JS renderCount AND
 * writes the Rust cache, perturbing the isolated cache-stats test). The nav
 * path `GET /_brust/page/cache-test` IS allowed: `/_brust/page/*` runs with
 * cache_wanted:false, so it neither writes the cache nor bumps hit/miss
 * counters. Stateful/special/long-lived-conn tests must use startServer(). */
function sharedPort(): number {
  if (!shared) throw new Error('shared server not started')
  return shared.port
}

test('serves rendered html via worker pool', async () => {
  const { port, stop } = await startServer({ workers: '4' })

  const resp = await fetch(`http://127.0.0.1:${port}/`)
  expect(resp.status).toBe(200)

  const body = await resp.text()
  expect(body).toContain('Hello from Brust')
  expect(body).toMatch(/worker_id=\d+/)

  const ping = await fetch(`http://127.0.0.1:${port}/ping`)
  expect(ping.status).toBe(200)
  expect(ping.headers.get('content-type')).toBe('text/plain')
  expect(await ping.text()).toBe('pong\n')

  const exit = await stop()
  expect(exit).toBe(0)
}, 15_000)

test('returns 414 when request exceeds MAX_REQUEST_BYTES', async () => {
  const { port, proc, stop } = await startServer({ rustLog: 'brust=warn' })

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
  // Wait for the server to write its 414 (or close silently). 1 s is overkill
  // on localhost; if the server hasn't closed by then, something is wrong.
  await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))])
  sock.end()

  const received = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))

  // Hyper migration: an oversized request-header block is now rejected by
  // hyper's own header-length guard (max_buf_size = max_request_bytes) with the
  // RFC-correct 431 Request Header Fields Too Large + Connection: close — the
  // hand-rolled parser used to emit a custom 414. Same intent (request too big,
  // socket closed), more correct status code.
  try {
    expect(received).toContain('431')
    expect(received.toLowerCase()).toContain('connection: close')
  } finally {
    await stop()
  }
  const exit = await proc.exited
  expect(exit).toBe(0)
}, 15_000)

test('routes /blog/:slug renders BlogPost with the slug param', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/blog/hello-world`)
  expect(resp.status).toBe(200)
  const body = await resp.text()
  expect(body).toContain('BlogPost')
  expect(body).toContain('hello-world') // the slug appears in the rendered HTML
  expect(body).toContain('Post: hello-world') // the loader-produced title appears
})

test('unknown path returns 404', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/no/such/path`)
  expect(resp.status).toBe(404)
})

test('errorBoundary renders when a route component throws', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/crash`)
  // errorBoundary returns 500 — the worker encodes the status into the
  // meta JSON envelope (`{status, headers?}`) at the head of the SAB;
  // Rust parses the meta before calling build_response.
  expect(resp.status).toBe(500)
  const body = await resp.text()
  expect(body).toContain('CrashBoundary')
  expect(body).toContain('intentional crash for test')
})

test('reads port and workers from brust.toml at cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-toml-'))
  try {
    const projectRoot = process.cwd()
    const tomlBody = ['[server]', 'port = 38125', '', '[workers]', 'count = 2', ''].join('\n')
    await writeFile(join(dir, 'brust.toml'), tomlBody)

    const proc = spawn({
      cmd: ['bun', 'run', join(projectRoot, 'tests/fixtures/app/index.ts')],
      cwd: dir,
      env: {
        // Strip env overrides so TOML is the only source of truth.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'BRUST_PORT' && k !== 'BRUST_WORKERS'),
        ),
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
  const { port, stop } = await startServer({ workers: '1' })
  try {
    const first = await fetch(`http://127.0.0.1:${port}/cache-test`)
    const firstBody = await first.text()
    expect(first.status).toBe(200)
    expect(firstBody).toMatch(/render=\d+/)

    const second = await fetch(`http://127.0.0.1:${port}/cache-test`)
    const secondBody = await second.text()
    expect(second.status).toBe(200)
    expect(secondBody).toBe(firstBody)
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, 15_000)

test('cache stats endpoint reflects hits and misses', async () => {
  const { port, stop } = await startServer({ workers: '1' })
  try {
    // Initially zero.
    const r0 = await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    expect(r0.status).toBe(200)
    expect(r0.headers.get('content-type')).toBe('application/json')
    const s0 = (await r0.json()) as { hits: number; misses: number; len: number; capacity: number }
    expect(s0.hits).toBe(0)
    expect(s0.misses).toBe(0)
    expect(s0.len).toBe(0)
    expect(s0.capacity).toBe(1000)

    // First /cache-test = miss + insert.
    await fetch(`http://127.0.0.1:${port}/cache-test`)
    // Second = hit.
    await fetch(`http://127.0.0.1:${port}/cache-test`)

    // moka is eventually-consistent: hits/misses are atomic (immediate) but
    // `len` is computed from pending tasks that may not have run yet. Poll a few
    // times so the assertion isn't racy on a cold run.
    let s1 = { hits: 0, misses: 0, len: 0, capacity: 0 }
    for (let i = 0; i < 20; i++) {
      const r1 = await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
      s1 = (await r1.json()) as { hits: number; misses: number; len: number; capacity: number }
      if (s1.hits >= 1 && s1.misses >= 1 && s1.len >= 1) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(s1.hits).toBeGreaterThanOrEqual(1)
    expect(s1.misses).toBeGreaterThanOrEqual(1)
    expect(s1.len).toBeGreaterThanOrEqual(1)
    expect(s1.capacity).toBe(1000)
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, 15_000)

test('middleware short-circuits with 401 when cookie missing', async () => {
  const port = sharedPort()
  const r = await fetch(`http://127.0.0.1:${port}/protected`)
  expect(r.status).toBe(401)
  expect(await r.text()).toBe('unauthorised')
  expect(r.headers.get('www-authenticate')).toBe('Cookie')
})

test('middleware lets request through when cookie present + req.cookies reaches component', async () => {
  const port = sharedPort()
  const r = await fetch(`http://127.0.0.1:${port}/protected`, {
    headers: { cookie: 'user=alice; sid=xyz' },
  })
  expect(r.status).toBe(200)
  // React 18 inserts <!-- --> between adjacent text nodes (text literal + {var}),
  // so strip those before the substring check.
  const body = (await r.text()).replace(/<!--\s*-->/g, '')
  expect(body).toContain('signed in as alice')
})

test('middleware injects x-render-ms response header + req.search reaches component', async () => {
  const port = sharedPort()
  const r = await fetch(`http://127.0.0.1:${port}/with-header?name=brust`)
  expect(r.status).toBe(200)
  const ms = r.headers.get('x-render-ms')
  expect(ms).not.toBeNull()
  expect(Number(ms)).toBeGreaterThanOrEqual(0)
  // React 18 inserts <!-- --> between adjacent text nodes (text literal + {var}),
  // so strip those before the substring check.
  const body = (await r.text()).replace(/<!--\s*-->/g, '')
  expect(body).toContain('Hello, brust')
})

test('errorBoundary 500 path does not pick up middleware-only headers', async () => {
  // /crash has no middleware; verifies that the chain-less terminal path
  // still flows status 500 through meta.status (not the legacy 2-byte prefix)
  // AND that no rogue middleware headers (e.g. x-render-ms from a global
  // middleware that doesn't exist yet) leak into the response. Complements
  // the existing /crash test which covers boundary HTML content.
  const port = sharedPort()
  const r = await fetch(`http://127.0.0.1:${port}/crash`)
  expect(r.status).toBe(500)
  expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(r.headers.get('x-render-ms')).toBeNull()
  const body = await r.text()
  expect(body).toContain('CrashBoundary')
})

test('invalidate by path drops a cached entry', async () => {
  const { port, stop } = await startServer({ workers: '1' })
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
    const body = (await inv.json()) as { removed: number }
    expect(body.removed).toBeGreaterThanOrEqual(1)

    // Next request re-renders (counter advances) → body must differ from firstBody.
    const reRender = await fetch(`http://127.0.0.1:${port}/cache-test`)
    expect(reRender.status).toBe(200)
    expect(await reRender.text()).not.toBe(firstBody)
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate all clears every entry + reports correct removed count', async () => {
  const { port, stop } = await startServer({ workers: '1' })
  try {
    // Warm /cache-test (only cached route in the example).
    await fetch(`http://127.0.0.1:${port}/cache-test`)
    const beforeStats = (await (
      await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    ).json()) as {
      hits: number
      misses: number
      len: number
      capacity: number
    }
    expect(beforeStats.len).toBeGreaterThanOrEqual(1)

    const inv = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?all=1`, {
      method: 'POST',
    })
    expect(inv.status).toBe(200)
    const body = (await inv.json()) as { removed: number }
    expect(body.removed).toBe(beforeStats.len)

    const afterStats = (await (
      await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    ).json()) as {
      hits: number
      misses: number
      len: number
    }
    expect(afterStats.len).toBe(0)
    // Counters are preserved (hits/misses survive clear).
    expect(afterStats.hits).toBe(beforeStats.hits)
    expect(afterStats.misses).toBe(beforeStats.misses)
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate endpoint rejects GET and unsupported queries', async () => {
  const { port, stop } = await startServer({ workers: '1' })
  try {
    // GET on the invalidate endpoint must not work (POST-only).
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?path=/x`)
    expect(wrongMethod.status).toBe(405)

    // POST without path or all=1 returns 400.
    const missingParams = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate`, {
      method: 'POST',
    })
    expect(missingParams.status).toBe(400)
    const body = (await missingParams.json()) as { error: string }
    expect(body.error).toContain('missing')
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, 15_000)

// Regression (deterministic): a 405 sends `Connection: keep-alive`, so the
// server MUST keep the socket open for the next request. It previously
// `return`ed (closed) after the invalidate-GET 405 while advertising keep-alive
// — a keep-alive client reusing the pooled-but-closed connection then failed
// with "socket closed unexpectedly" (intermittent CI flake). Raw socket so the
// connection reuse is explicit, not at the mercy of fetch's pool heuristics.
test('405 on invalidate keeps the keep-alive connection open (no close-after-405)', async () => {
  const { port, stop } = await startServer({ workers: '1' })
  try {
    let buf = ''
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(_s, d) {
          buf += new TextDecoder().decode(d)
        },
      },
    })
    // Request 1: GET (405, keep-alive) on the same socket.
    sock.write(
      'GET /_brust/cache/invalidate?path=/x HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n',
    )
    await Bun.sleep(150)
    const first = buf.split('\r\n')[0]
    buf = ''
    // Request 2: POST on the SAME connection — must arrive, proving keep-alive.
    sock.write(
      'POST /_brust/cache/invalidate HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    )
    await Bun.sleep(200)
    const second = buf.split('\r\n')[0]
    sock.end()
    expect(first).toContain('405')
    expect(second).toContain('400') // connection survived the 405; not empty/closed
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, 15_000)

test('island marker + importmap injected when route uses <Island>', async () => {
  const port = sharedPort()
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
}, 15_000)

test('island chunk + bootstrap served at /_brust/islands/<file>', async () => {
  const port = sharedPort()
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
}, 15_000)

test('routes without <Island> ship no importmap or bootstrap', async () => {
  const port = sharedPort()
  // /blog/{slug} doesn't use <Island>.
  const r = await fetch(`http://127.0.0.1:${port}/blog/test-slug`)
  expect(r.status).toBe(200)
  const body = await r.text()
  expect(body).not.toContain('data-brust-island=')
  expect(body).not.toContain('<script type="importmap">')
  expect(body).not.toContain('_bootstrap.js')
}, 15_000)

// ----- Server-action endpoints (treaty wire) -----
//
// Migrated to the `defineActions` / treaty wire (M1): `METHOD <prefix>/<path>`
// with a JSON OBJECT body. The fixture registers POST /notes, GET /whoami, and
// DELETE /notes/{id} (requireUser middleware). The old positional-args wire
// (`POST /_brust/action/createNote` with a JSON ARRAY body) and the multipart /
// urlencoded body paths were removed. MCP tools are now derived from these
// `EndpointDef`s and `tools/call` dispatches over them (see the MCP tools/list +
// tools/call tests below). The HTTP-transport guards exercise the Rust framing
// layer (not the wire shape) and are repointed at POST/DELETE /notes. Post-S12
// they encode the RFC-compliant behavior: a MISSING Content-Length is a valid
// bodyless request (no longer 411 — it reaches the handler with an empty body);
// only Transfer-Encoding is rejected with 411, and an oversized declared
// Content-Length is still 413.

test('action endpoint: happy path returns JSON', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi there' }),
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('application/json')
    const body = (await resp.json()) as { id: string }
    expect(body.id).toMatch(/^n-\d+$/)
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: malformed JSON body → 400', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(resp.status).toBe(400)
    const body = await resp.text()
    expect(body).toContain('invalid JSON body')
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: body fails schema validation → 422', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    // text must be a string; a number trips the zod body schema.
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 123 }),
    })
    expect(resp.status).toBe(422)
    const body = await resp.text()
    expect(body).toContain('validation failed')
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: unknown path → 404', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(resp.status).toBe(404)
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: known path wrong method → 405', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    // /notes is POST-only; a GET is method-not-allowed.
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/notes`)
    expect(resp.status).toBe(405)
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: missing Content-Length → no longer 411 (RFC bodyless)', async () => {
  // S12: a request with no Content-Length and no Transfer-Encoding is a valid
  // RFC bodyless request — it must NOT be rejected with 411. It reaches the
  // handler with an empty body; for POST /notes the empty body then fails the
  // zod body schema downstream (→ 422). fetch always sets Content-Length, so we
  // use a raw socket like the 414 test to send a request with NO CL header.
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
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
    // Hand-crafted request: no Content-Length, no body.
    sock.write('POST /_brust/action/notes HTTP/1.1\r\nHost: x\r\n\r\n')
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000))])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    const statusLine = combined.split('\r\n')[0]
    // EMPIRICALLY OBSERVED: bodyless POST /notes → empty body → zod body
    // validation fails → 422 (not the old 411).
    expect(statusLine).not.toContain('411')
    expect(statusLine).toContain('422')
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: bodyless DELETE (no Content-Length) → 200 (RFC bodyless)', async () => {
  // S12: a bodyless DELETE is valid per RFC and must reach the handler with an
  // empty body. We MUST use a raw socket: fetch() always sets `Content-Length: 0`
  // on a bodyless request, which masks the bug entirely — the framing path that
  // S12 fixes is only exercised when NO Content-Length header is present at all.
  // DELETE /notes/{id} is gated by requireUser, so we send the user cookie; the
  // handler then returns { ok: true, id: 'n-1' } → 200.
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
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
    sock.write(
      'DELETE /_brust/action/notes/n-1 HTTP/1.1\r\n' + 'Host: x\r\n' + 'Cookie: user=alice\r\n\r\n',
    )
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000))])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    expect(combined.split('\r\n')[0]).toContain('200')
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: Transfer-Encoding chunked is now decoded by hyper', async () => {
  // Hyper migration: the hand-rolled parser couldn't decode chunked bodies and
  // rejected them with 411. Hyper de-chunks transparently, so a chunked action
  // body now reaches the handler like any sized body — the request is no longer
  // rejected at the transport layer. Raw socket: fetch won't forge chunked.
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
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
    // A complete chunked-encoded JSON body. hyper de-chunks and hands the
    // decoded body to the action handler.
    sock.write(
      'POST /_brust/action/notes HTTP/1.1\r\n' +
        'Host: x\r\n' +
        'Content-Type: application/json\r\n' +
        'Transfer-Encoding: chunked\r\n\r\n' +
        'd\r\n{"text":"hi"}\r\n0\r\n\r\n',
    )
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000))])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    // Transport no longer rejects with 411; the request reaches the handler and
    // gets a normal HTTP response (2xx from the notes action).
    expect(combined.split('\r\n')[0]).not.toContain('411')
    expect(combined).toMatch(/^HTTP\/1\.1 2\d\d/)
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: Content-Length > 256 KB → 413', async () => {
  // Server rejects oversized bodies BEFORE reading them: parse_content_length
  // returns > MAX_ACTION_BODY_BYTES (256 KB) and writes 413 immediately.
  // Use a raw socket so we can claim a large Content-Length without actually
  // sending the bytes — the server should 413 from headers alone.
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
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
    sock.write(
      'POST /_brust/action/notes HTTP/1.1\r\n' +
        'Host: x\r\n' +
        'Content-Length: 300000\r\n' +
        '\r\n',
    )
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000))])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    expect(combined.split('\r\n')[0]).toContain('413')
  } finally {
    await stop()
  }
}, 15_000)

test('action middleware: short-circuits without cookie (401)', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    // DELETE /notes/{id} is gated by requireUser — no cookie → 401.
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/notes/n-123`, {
      method: 'DELETE',
    })
    expect(resp.status).toBe(401)
    expect(await resp.text()).toBe('login required')
  } finally {
    await stop()
  }
}, 15_000)

test('action middleware: passes through with cookie', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/notes/n-123`, {
      method: 'DELETE',
      headers: { Cookie: 'user=alice' },
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; id: string }
    expect(body.ok).toBe(true)
    expect(body.id).toBe('n-123')
  } finally {
    await stop()
  }
}, 15_000)

test('action endpoint: GET /whoami returns null user without cookie', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/whoami`)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { user: string | null }
    expect(body.user).toBeNull()
  } finally {
    await stop()
  }
}, 15_000)

test('custom actionPrefix: routes under prefix + injects browser global', async () => {
  const { port, stop } = await startServer({
    rustLog: 'brust=warn',
    env: { BRUST_ACTION_PREFIX: '/api' },
  })
  try {
    // (a) action routes under the custom prefix
    const ok = await fetch(`http://127.0.0.1:${port}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(ok.status).toBe(200)
    // Default prefix no longer routes actions. A POST to the (now unmounted)
    // default path is rejected by Rust's method gate (server.rs: only GET, or
    // POST to a registered action / cache-invalidate / mcp path is allowed) —
    // so it's 405 "method not allowed", NOT the action's 200 JSON. (The plan
    // expected 404, but the method gate fires before page routing for non-GET;
    // a GET to the same path 404s. Either way the action no longer responds.)
    const def = await fetch(`http://127.0.0.1:${port}/_brust/action/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(def.status).toBe(405)
    expect(await def.text()).not.toContain('n-')
    // (b) a non-Suspense HTML page injects the global before </head>.
    // `/` (HelloWorld) has no <Suspense> → buffering path (see the
    // "single-chunk regression" test) → script is spliced before </head>.
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(html).toContain('globalThis.__BRUST_ACTION_PREFIX__="/api"')
    expect(html.indexOf('__BRUST_ACTION_PREFIX__')).toBeLessThan(html.indexOf('</head>'))
  } finally {
    await stop()
  }
}, 15_000)

test('action: PUT /notes/{id} round-trips', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/notes/abc`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ id: 'abc', text: 'hello', updated: true })
})

test('action: PATCH /notes/{id} round-trips', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/notes/xy`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'p' }),
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ id: 'xy', patched: 'p' })
})

test('action: HEAD /notes/{id} returns 200 (body currently shipped, not stripped)', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/notes/h`, {
    method: 'HEAD',
  })
  expect(r.status).toBe(200)
  // OQ#1: Rust does not strip the HEAD body. Assert reality; do not assert empty.
})

test('action: GET /search 422 on invalid query', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/search?limit=abc`)
  expect(r.status).toBe(422)
})

test('action: GET /search 200 on valid query', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/search?limit=5`)
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ limit: 5 })
})

test('action: urlencoded body coerces + validates', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=alice',
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ name: 'alice' })
})

test('action: multipart body coerces + validates', async () => {
  const fd = new FormData()
  fd.append('name', 'bob')
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/upload`, {
    method: 'POST',
    body: fd,
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ name: 'bob' })
})

test('action-calling island page renders marker + importmap + bootstrap', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
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
    await stop()
  }
}, 20_000)

test('nested routes: index route renders parent layout + dashboard', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
    headers: { cookie: 'user=alice' },
  })
  expect(resp.status).toBe(200)
  const body = await resp.text()
  expect(body).toContain('AdminLayout')
  expect(body).toContain('AdminDashboard')
})

test('nested routes: child path inherits parent middleware (401 without cookie)', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/admin/users`)
  expect(resp.status).toBe(401)
})

test('nested routes: param child renders with id from path', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/admin/users/42`, {
    headers: { cookie: 'user=alice' },
  })
  expect(resp.status).toBe(200)
  const body = await resp.text()
  expect(body).toContain('AdminLayout')
  expect(body).toContain('AdminUserDetail')
  // React 18 SSR may insert comment markers between text nodes, so
  // grep for the id value itself (42), not the literal 'id=42'.
  expect(body).toMatch(/id\D*42/)
})

test('nested routes: parent errorBoundary catches child throw', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/admin/users/throw`, {
    headers: { cookie: 'user=alice' },
  })
  expect(resp.status).toBe(500)
  const body = await resp.text()
  expect(body).toContain('AdminErrorBoundary')
  expect(body).toContain('intentional admin child throw')
})

test('nested routes: flat route still renders (no regression)', async () => {
  // Sanity test: the existing flat `/` route still works after the
  // flatten + chain-walker refactor.
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/`)
  expect(resp.status).toBe(200)
  const body = await resp.text()
  expect(body).toContain('Hello from Brust')
})

async function mcpRequest(
  port: number,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: resp.status, body: await resp.json() }
}

test('mcp: initialize returns server capabilities', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { status, body } = await mcpRequest(port, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    })
    expect(status).toBe(200)
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.serverInfo.name).toBe('brust')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.capabilities.resources).toBeDefined()
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/list returns action-derived tools', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'tools/list')
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toContain('post_notes')
    expect(names).toContain('get_whoami')
    expect(names).toContain('delete_notes_by_id')
    const post = body.result.tools.find((t: any) => t.name === 'post_notes')
    expect(post.inputSchema.properties.body).toBeDefined()
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/call post_notes round-trips through dispatch', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'post_notes',
      arguments: { body: { text: 'hi' } },
    })
    expect(body.result.isError).toBe(false)
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: 'n-2' })
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/call post_notes 422 on invalid body', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'post_notes',
      arguments: { body: {} },
    })
    expect(body.result.isError).toBe(true)
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/call honors action middleware (cookie gate)', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const no = await mcpRequest(port, 'tools/call', {
      name: 'delete_notes_by_id',
      arguments: { params: { id: 'x' } },
    })
    expect(no.body.result.isError).toBe(true)
    const yes = await mcpRequest(
      port,
      'tools/call',
      { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } },
      { Cookie: 'user=alice' },
    )
    expect(yes.body.result.isError).toBe(false)
    expect(JSON.parse(yes.body.result.content[0].text)).toEqual({ ok: true, id: 'x' })
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: resources/list returns loaders', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'resources/list')
    const uris = body.result.resources.map((r: any) => r.uri)
    expect(uris).toContain('brust:///blog/{slug}')
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: resources/read fetches loader output', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'resources/read', { uri: 'brust:///blog/hello' })
    expect(body.result.contents).toHaveLength(1)
    const content = body.result.contents[0]
    expect(content.uri).toBe('brust:///blog/hello')
    const data = JSON.parse(content.text)
    expect(data.title).toBe('Post: hello')
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: prompts/list returns empty', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'prompts/list')
    expect(body.result.prompts).toEqual([])
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: unknown method returns -32601', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'nonexistentMethod')
    expect(body.error.code).toBe(-32601)
  } finally {
    await stop()
  }
}, 15_000)

// ----- buffering response: uncached vs cached wire-shape smoke -----
//
// Sub-project M (2026-05-28): dispatch helper grew a `cache_wanted: bool`
// parameter to skip an unconditional response_bytes_for_cache.clone() on
// uncached routes. Both paths must still produce equivalent HTTP/1.1 wire
// shape (same status, header order, Content-Length matching body bytes, no
// Transfer-Encoding). fetch() reframes headers, so we read raw socket bytes.
test('buffering: uncached and cached responses share wire shape', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    // `/` is uncached → goes through the new vectored path.
    const uncachedBytes = await rawRequest(
      port,
      `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    )
    // `/cache-test` is cached → first request goes through the concat path
    // (cache miss → build_single_response_bytes → insert).
    const cachedBytes = await rawRequest(
      port,
      `GET /cache-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    )

    const uncached = parseHttpResponse(uncachedBytes)
    const cached = parseHttpResponse(cachedBytes)

    // Both paths emit a normal 200 response.
    expect(uncached.status).toBe(200)
    expect(cached.status).toBe(200)

    // Both paths must declare Content-Length (single-chunk Content-Length
    // response, NOT chunked transfer encoding).
    expect(uncached.headers.get('content-length')).toBeTruthy()
    expect(cached.headers.get('content-length')).toBeTruthy()
    expect(uncached.headers.has('transfer-encoding')).toBe(false)
    expect(cached.headers.has('transfer-encoding')).toBe(false)

    // Content-Length must match actual body byte length.
    expect(uncached.body.length).toBe(parseInt(uncached.headers.get('content-length')!, 10))
    expect(cached.body.length).toBe(parseInt(cached.headers.get('content-length')!, 10))

    // Both carry a Content-Type. (Hyper now owns header emission/order — the
    // exact pre-hyper Content-Type-before-Content-Length ordering is no longer
    // guaranteed by us, so we assert presence, not order. hyper also adds Date.)
    expect(uncached.headers.get('content-type')).toBeTruthy()
    expect(cached.headers.get('content-type')).toBeTruthy()
  } finally {
    await stop()
  }
}, 15_000)

async function rawRequest(port: number, request: string): Promise<Uint8Array> {
  // Brust's HTTP server always responds with `Connection: keep-alive` regardless
  // of the request's Connection header — it loops until the client closes the
  // socket or sends invalid bytes. We can't rely on `sock.on('end')` to detect
  // "response complete". Instead: collect chunks, debounce on a 200ms quiet
  // period, then close from our side. For these tiny responses (~5 KB), one
  // TCP segment lands well within that window.
  const net = await import('node:net')
  return await new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(request)
    })
    const chunks: Uint8Array[] = []
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (quietTimer) clearTimeout(quietTimer)
      sock.destroy()
      const total = chunks.reduce((a, b) => a + b.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.length
      }
      resolve(out)
    }
    sock.on('data', (d: Buffer) => {
      chunks.push(new Uint8Array(d))
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, 200)
    })
    sock.on('end', finish)
    sock.on('error', reject)
  })
}

function parseHttpResponse(bytes: Uint8Array): {
  status: number
  headers: Map<string, string>
  headerOrder: string[]
  body: Uint8Array
} {
  let end = -1
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('no header terminator in response')
  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, end))
  const body = bytes.subarray(end + 4)
  const lines = headerText.split('\r\n')
  const statusLine = lines[0]
  const status = parseInt(statusLine.split(' ')[1], 10)
  const headers = new Map<string, string>()
  const headerOrder: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx < 0) continue
    const name = lines[i].slice(0, idx).toLowerCase().trim()
    const value = lines[i].slice(idx + 1).trim()
    headers.set(name, value)
    headerOrder.push(name)
  }
  return { status, headers, headerOrder, body }
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
      new Promise<typeof _TICK>((resolve) => setTimeout(() => resolve(_TICK), 100)),
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
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(all)
}

test('sse: 3 data frames in order then close', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
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
    await stop()
  }
}, 15_000)

test('sse: heartbeat ping arrives on idle stream', async () => {
  // /sse-idle uses sseOptions.heartbeatMs=100 so we don't wait 15s for
  // the default heartbeat. Stream never enqueues data, so any bytes
  // observed must be the framework's `: ping\n\n` heartbeat.
  // Bun's fetch API buffers SSE body chunks until the stream closes, so
  // we use a raw TCP socket (same pattern as the 414/411 tests) to observe
  // frames as they arrive from the wire.
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const rawChunks: Uint8Array[] = []
    let resolveClose!: () => void
    const closed = new Promise<void>((r) => {
      resolveClose = r
    })
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(_s, d) {
          rawChunks.push(new Uint8Array(d))
        },
        open(s) {
          s.write('GET /sse-idle HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n')
        },
        close() {
          resolveClose()
        },
        drain() {},
        error() {
          resolveClose()
        },
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
    await stop()
  }
}, 15_000)

test('sse: client disconnect fires req.signal abort within 1s', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const { resp, ctrl } = await openSseConn(port, '/sse-counter')
    expect(resp.status).toBe(200)
    ctrl.abort()
    await new Promise((r) => setTimeout(r, 1000))

    // BRUST_WORKERS=1 ensures the probe action lands on the same JS
    // context that ran the SSE handler — so __lastSseAbort is set.
    const probe = await fetch(`http://127.0.0.1:${port}/_brust/action/last-sse-abort`)
    expect(probe.status).toBe(200)
    const { ts } = (await probe.json()) as { ts: number }
    expect(ts).toBeGreaterThan(0)
  } finally {
    await stop()
  }
}, 15_000)

test('sse: middleware reject returns 401 + non-SSE content-type', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const { resp } = await openSseConn(port, '/sse-gated')
    expect(resp.status).toBe(401)
    expect(resp.headers.get('content-type') ?? '').not.toContain('text/event-stream')
  } finally {
    await stop()
  }
}, 15_000)

test('sse: middleware pass with cookie streams normally', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const { resp } = await openSseConn(port, '/sse-gated', { cookie: 'user=alice' })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/event-stream')
    const text = await readAllText(resp)
    expect(text).toContain('data: 1\n\n')
    expect(text).toContain('data: 3\n\n')
  } finally {
    await stop()
  }
}, 15_000)

test('sse: POST to an SSE route returns 405', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/sse-counter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    })
    expect(resp.status).toBe(405)
  } finally {
    await stop()
  }
}, 15_000)

// ----- WS integration tests -----

function makeWsClient(
  port: number,
  path: string,
  subprotocols?: string[],
): {
  ws: WebSocket
  opened: Promise<void>
  closed: Promise<{ code: number; reason: string }>
  messages: Promise<(string | ArrayBuffer)[]>
} {
  const url = `ws://127.0.0.1:${port}${path}`
  const ws = subprotocols ? new WebSocket(url, subprotocols) : new WebSocket(url)
  let resolveOpen: () => void
  let resolveClose: (v: { code: number; reason: string }) => void
  let resolveMessages: (v: (string | ArrayBuffer)[]) => void
  const opened = new Promise<void>((r) => {
    resolveOpen = r
  })
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    resolveClose = r
  })
  const msgs: (string | ArrayBuffer)[] = []
  const messages = new Promise<(string | ArrayBuffer)[]>((r) => {
    resolveMessages = r
  })
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    resolveOpen()
  }
  ws.onmessage = (e) => {
    msgs.push(e.data as string | ArrayBuffer)
  }
  ws.onclose = (e) => {
    resolveMessages(msgs)
    resolveClose({ code: e.code, reason: e.reason })
  }
  ws.onerror = () => {
    /* swallow; close will fire */
  }
  return { ws, opened, closed, messages }
}

test('ws: handshake + echo', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.send('hello')
    await new Promise((r) => setTimeout(r, 200))
    c.ws.close()
    const got = await c.messages
    expect(got).toContain('hello')
  } finally {
    await stop()
  }
}, 15_000)

test('ws: binary frame round-trip', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
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
    await stop()
  }
}, 15_000)

test('ws: server-initiated close fires client onclose with code 4000', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const c = makeWsClient(port, '/ws/server-close')
    const closed = await c.closed
    expect(closed.code).toBe(4000)
    expect(closed.reason).toBe('bye')
  } finally {
    await stop()
  }
}, 15_000)

test('ws: middleware reject returns 401 + no upgrade', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/ws/gated`, {
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    })
    expect(resp.status).toBe(401)
    expect(resp.headers.get('content-type') ?? '').not.toContain('websocket')
  } finally {
    await stop()
  }
}, 15_000)

test('ws: middleware pass with cookie completes handshake + echo', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/gated`, {
      headers: { cookie: 'user=alice' },
    } as any)
    const got: string[] = []
    let closed = false
    ws.onopen = () => {
      ws.send('hi')
    }
    ws.onmessage = (e) => {
      got.push(e.data as string)
      ws.close()
    }
    ws.onclose = () => {
      closed = true
    }
    await new Promise((r) => setTimeout(r, 1500))
    expect(got).toContain('hi')
    expect(closed).toBe(true)
  } finally {
    await stop()
  }
}, 15_000)

test('ws: subprotocol negotiation picks first match in route order', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
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
    await stop()
  }
}, 15_000)

test('ws: client clean close fires server on_close with 1000', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.close()
    await new Promise((r) => setTimeout(r, 500))

    // BRUST_WORKERS=1 ensures the probe action lands on the same JS
    // context that ran the WS handler.
    const probe = await fetch(`http://127.0.0.1:${port}/_brust/action/last-ws-close`)
    expect(probe.status).toBe(200)
    const { code } = (await probe.json()) as { code: number; reason: string }
    expect(code).toBe(1000)
  } finally {
    await stop()
  }
}, 15_000)

// ----- HTML Streaming integration tests -----

test('streaming: single-chunk regression — / uses Content-Length, not chunked', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/`)
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-length')).not.toBeNull()
  expect(resp.headers.get('transfer-encoding')).toBeNull()
  const body = await resp.text()
  expect(body.length).toBeGreaterThan(0)
})

test('streaming: /slow-suspense uses Transfer-Encoding: chunked + shell-before-resolved', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
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
      if (
        !sawSpinnerBeforeResolved &&
        acc.includes('loading...') &&
        !acc.includes('Resolved after 200ms')
      ) {
        sawSpinnerBeforeResolved = true
      }
    }
    expect(sawSpinnerBeforeResolved).toBe(true)
    expect(acc).toContain('Resolved after 200ms')
  } finally {
    await stop()
  }
}, 15_000)

test('renderSlots>1: two concurrent Suspense renders interleave on ONE worker', async () => {
  // The multi-render-per-worker payoff, proven end-to-end. One worker, two render
  // slots. `/slow-fresh` suspends ~150ms with a per-REQUEST-fresh promise, so two
  // concurrent requests each wait independently — and on two slots those waits
  // OVERLAP. The concurrent pair must finish in roughly one render's time, not two.
  // (At renderSlots=1 the second request would queue behind the first → ~2×, so
  // this also guards the env→slot plumbing from regressing.)
  const { port, stop } = await startServer({
    workers: '1',
    env: { BRUST_RENDER_SLOTS: '2' },
    rustLog: 'brust=warn',
  })
  try {
    const url = `http://127.0.0.1:${port}/slow-fresh`
    const get = () => fetch(url).then((r) => r.text())
    const pairConcurrent = async () => {
      const t = performance.now()
      const [a, b] = await Promise.all([get(), get()])
      return { ms: performance.now() - t, a, b }
    }

    // Warm up (island chunk build, JIT, first-hit costs) so the timings are clean.
    await get()

    // Serial: two back-to-back renders ≈ 2 × ~200ms.
    const s0 = performance.now()
    await get()
    await get()
    const serial = performance.now() - s0

    // Concurrent: two at once ≈ ~200ms — the waits overlap across the two slots.
    // Take the faster of two trials to filter a single full-suite-contention blip
    // (the timer wait is I/O and overlaps regardless of host CPU, so the floor is
    // stable; only an unlucky trial inflates).
    const t1 = await pairConcurrent()
    const t2 = await pairConcurrent()
    const concurrent = Math.min(t1.ms, t2.ms)

    // Both renders produced the resolved Suspense content (no cross-slot corruption).
    for (const { a, b } of [t1, t2]) {
      expect(a).toContain('fresh after 200ms')
      expect(b).toContain('fresh after 200ms')
    }

    // Interleave: two overlapping ~200ms waits → ~0.5× serial. Assert < 0.75× with
    // generous CI headroom. A regression to one-render-per-worker (e.g. the
    // env→slot plumbing breaking) would push this to ~1.0 and fail.
    expect(concurrent).toBeLessThan(serial * 0.75)
  } finally {
    await stop()
  }
}, 30_000)

test('streaming: mid-stream disconnect — second request to same worker still succeeds', async () => {
  const { port, stop } = await startServer({ workers: '1', rustLog: 'brust=warn' })
  try {
    // First request: open the chunked stream, then abort mid-flight.
    const ac = new AbortController()
    const first = fetch(`http://127.0.0.1:${port}/slow-suspense`, { signal: ac.signal }).catch(
      (e: Error) => ({ aborted: true, msg: e.message }),
    )
    // Give the server time to commit headers + first chunk before we abort.
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await first // resolves to { aborted: true } via the .catch

    // Wait a beat for slot Drop guard to fire.
    await new Promise((r) => setTimeout(r, 200))

    // Second request to the SAME worker (BRUST_WORKERS=1) MUST succeed —
    // proves RenderSlotGuard cleared the leaked slot on the cancelled request.
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body.length).toBeGreaterThan(0)
  } finally {
    await stop()
  }
}, 15_000)

// ----- Navigation interceptor integration tests -----

test('nav: /_brust/page/blog/x returns JSON {html, title} with <main> inner only', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/blog/welcome`)
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type') ?? '').toContain('application/json')
  const body = (await resp.json()) as { html: string; title: string }
  expect(typeof body.html).toBe('string')
  expect(typeof body.title).toBe('string')
  // <main> chrome excluded — no header/footer literals
  expect(body.html).not.toContain('<header')
  expect(body.html).not.toContain('<footer')
  // Page-specific content present
  expect(body.html).toContain('Post: welcome')
  // Title carries the page name
  expect(body.title).toContain('Post: welcome')
})

test('nav: /_brust/page/<unknown> returns 404 with JSON error envelope', async () => {
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/this/path/does/not/exist`)
  expect(resp.status).toBe(404)
  expect(resp.headers.get('content-type') ?? '').toContain('application/json')
  const body = (await resp.json()) as { error: string }
  expect(body.error).toBe('not found')
})

test('nav: page without <main> falls back to shipping full HTML in html field', async () => {
  // The fixture's /cache-test route renders CacheTest, which is a bare
  // fragment (<h1>CacheTest</h1><p>render=N</p>) with no <main> wrapper.
  // The navigation branch detects the missing <main> and ships the full
  // rendered HTML instead, so the client interceptor fires its no-main
  // fallback. (/crash was the plan's original choice but renderToString
  // does not honour errorBoundary — it propagates the throw as a 500.)
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/cache-test`)
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type') ?? '').toContain('application/json')
  const body = (await resp.json()) as { html: string; title: string }
  // Full HTML fallback — no <main> in the response, but the
  // CacheTest content is present.
  expect(body.html).not.toContain('<main')
  expect(body.html).toContain('CacheTest')
})

test('nav: /_brust/page/<protected> without cookie returns middleware verdict (401)', async () => {
  // /admin (index) is guarded by authRequired middleware on the parent layout
  // (no cookie → 401). The navigation endpoint must honour middleware
  // short-circuits, otherwise it would leak guarded content via the JSON envelope.
  const port = sharedPort()
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/admin`)
  // Middleware short-circuits with 401 before render happens — the client
  // will treat any non-2xx as a fallback trigger (full reload).
  expect(resp.status).toBe(401)
  // The response body should NOT contain the rendered admin dashboard.
  const body = await resp.text()
  expect(body).not.toContain('Admin Dashboard')
})

// NOTE: native-route HTTP coverage — including the S9 notFound()/redirect()
// status sentinels — lives in tests/native-island-ssr.test.ts, which runs a
// `brust build` pre-flight so the fixture's jinja templates are registered.
// This suite boots the fixture in SOURCE mode (no build), so native routes are
// not exercised here. S12 action-dispatch coverage (bodyless / chunked) is
// above and needs no jinja.
