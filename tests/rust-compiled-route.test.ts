import { test, expect } from 'bun:test'
import { spawn } from 'bun'

// A2.2 — end-to-end: brust server boots with `/_test/rust-static` declared as
// `rustCompiled: 'static_hello'`. The dispatcher short-circuits React and ships
// the bytes produced by `napiRenderCompiled('static_hello', '{}')`.

const EXPECTED_HTML =
  '<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>'

async function readPortLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error('process closed stdout before listening log')
    acc += decoder.decode(value, { stream: true })
    const m = acc.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m) { reader.releaseLock(); return parseInt(m[1]!, 10) }
  }
}

test('GET /_test/rust-static returns Rust-compiled HTML bytes with matching Content-Length', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38201', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  try {
    const port = await readPortLine(proc.stdout)

    const resp = await fetch(`http://127.0.0.1:${port}/_test/rust-static`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toMatch(/text\/html/)

    const cl = resp.headers.get('content-length')
    expect(cl).not.toBeNull()
    expect(Number(cl)).toBe(EXPECTED_HTML.length)

    const body = await resp.text()
    expect(body).toBe(EXPECTED_HTML)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 10_000)
