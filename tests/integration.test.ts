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

  proc.kill('SIGINT')
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
