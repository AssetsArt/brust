import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures')
const SOURCE_FIXTURE = path.join(FIXTURES_DIR, 'app')

export interface DevFrame {
  type: string
  [key: string]: unknown
}

export class HotReloadHarness {
  readonly fixtureDir: string
  readonly port: number
  readonly baseUrl: string
  readonly messages: DevFrame[] = []
  readonly logs: string[] = []

  private proc: ReturnType<typeof Bun.spawn> | null = null
  private ws: WebSocket | null = null

  private constructor(fixtureDir: string, port: number) {
    this.fixtureDir = fixtureDir
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  static async create(): Promise<HotReloadHarness> {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const fixtureDir = path.join(FIXTURES_DIR, `hot-reload-reliability-${suffix}`)
    cpSync(SOURCE_FIXTURE, fixtureDir, { recursive: true })
    rmSync(path.join(fixtureDir, '.brust'), { recursive: true, force: true })
    return new HotReloadHarness(fixtureDir, await reservePort())
  }

  async start(workers: number): Promise<void> {
    if (this.proc) throw new Error('hot-reload harness already started')
    this.proc = Bun.spawn({
      cmd: [
        process.execPath,
        '../../../runtime/cli/index.ts',
        'dev',
        'index.ts',
        '--port',
        String(this.port),
      ],
      cwd: this.fixtureDir,
      env: {
        ...process.env,
        BRUST_NO_TUI: '1',
        BRUST_WORKERS: String(workers),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    void this.pump(this.proc.stdout, 'stdout')
    void this.pump(this.proc.stderr, 'stderr')

    await this.waitForReady()
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/_brust/dev`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('dev WebSocket open timed out')), 5000)
      this.ws!.onopen = () => {
        clearTimeout(timeout)
        resolve()
      }
      this.ws!.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('dev WebSocket failed to open'))
      }
    })
    this.ws.onmessage = (event) => {
      try {
        this.messages.push(JSON.parse(String(event.data)))
      } catch {
        this.logs.push(`ws: ${String(event.data)}`)
      }
    }
  }

  cursor(): number {
    return this.messages.length
  }

  path(relativePath: string): string {
    return path.join(this.fixtureDir, relativePath)
  }

  read(relativePath: string): string {
    return readFileSync(this.path(relativePath), 'utf8')
  }

  write(relativePath: string, contents: string): void {
    writeFileSync(this.path(relativePath), contents)
  }

  async fetchText(pathname: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}${pathname}`)
    if (!response.ok) throw new Error(`GET ${pathname} returned ${response.status}`)
    return response.text()
  }

  async waitForText(pathname: string, expected: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let lastResult = 'no response'
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}${pathname}`)
        const body = await response.text()
        lastResult = `HTTP ${response.status}: ${body.slice(0, 200)}`
        if (response.ok && body.includes(expected)) return body
      } catch (error) {
        lastResult = String(error)
      }
      await sleep(50)
    }
    throw new Error(`GET ${pathname} did not contain ${JSON.stringify(expected)}: ${lastResult}`)
  }

  async waitForTypes(expected: string[], from = 0, timeoutMs = 20000): Promise<DevFrame[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frames = this.messages.slice(from)
      if (frames.length >= expected.length) {
        const actual = frames.slice(0, expected.length).map((frame) => frame.type)
        if (actual.join('\0') !== expected.join('\0')) {
          throw new Error(
            `unexpected dev messages: expected ${expected.join(' → ')}, received ${actual.join(' → ')}\n${this.logTail()}`,
          )
        }
        return frames.slice(0, expected.length)
      }
      if (this.proc?.exitCode !== null) {
        throw new Error(`dev process exited before ${expected.join(' → ')}\n${this.logTail()}`)
      }
      await sleep(25)
    }
    throw new Error(
      `timed out waiting for ${expected.join(' → ')}; received ${this.messages
        .slice(from)
        .map((frame) => frame.type)
        .join(' → ')}\n${this.logTail()}`,
    )
  }

  async cleanup(): Promise<void> {
    try {
      this.ws?.close()
    } catch {
      // Best-effort teardown; the fixture removal below is mandatory.
    }
    this.ws = null

    const proc = this.proc
    this.proc = null
    if (proc?.exitCode === null) {
      try {
        proc.kill('SIGINT')
      } catch {
        // The process may have crashed between the exitCode check and signal.
      }
      await Promise.race([proc.exited, sleep(2000)])
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        await Promise.race([proc.exited, sleep(2000)])
      }
    }
    rmSync(this.fixtureDir, { recursive: true, force: true })
  }

  private async waitForReady(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${this.baseUrl}/ping`)).status === 200) return
      } catch (error) {
        lastError = error
      }
      if (this.proc?.exitCode !== null) break
      await sleep(100)
    }
    throw new Error(`dev server did not become ready: ${String(lastError)}\n${this.logTail()}`)
  }

  private async pump(
    stream: ReadableStream<Uint8Array> | number | null | undefined,
    label: string,
  ): Promise<void> {
    if (!stream || typeof stream === 'number') return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      for (const line of text.split('\n')) {
        if (line.length > 0) this.logs.push(`${label}: ${line}`)
      }
    }
  }

  private logTail(): string {
    return this.logs.slice(-30).join('\n')
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('failed to reserve a localhost port')
  }
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
