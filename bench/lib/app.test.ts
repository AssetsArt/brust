import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { portInUse, startApp } from './app'
import { mulberry32, shuffle } from './random'

const fixtures = join(import.meta.dir, 'fixtures')
const fake = (file: string, env: Record<string, string> = {}) => ({
  id: 'bun-serve' as const,
  port: 0,
  cwd: fixtures,
  startCmd: () => ({ cmd: ['bun', join(fixtures, file)], env }),
  ready: /listening on http:\/\/127\.0\.0\.1:(\d+)/,
})

test('startApp scrapes the port from stdout, the server answers, stop() ends the child', async () => {
  const app = await startApp(fake('fake-server.ts'))
  expect(app.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const r = await fetch(`${app.base}/types`)
  expect(await r.text()).toContain('<main>')
  await app.stop()
  expect(app.proc.exitCode ?? 0).toBeGreaterThanOrEqual(0)
  expect(app.log()).toContain('[fake] listening')
})

test('startApp rejects when the ready line never comes and the child is killed', async () => {
  const t0 = Date.now()
  await expect(startApp(fake('never-ready.ts'), { timeoutMs: 800 })).rejects.toThrow(/not ready after 800 ms[\s\S]*no listening line/)
  expect(Date.now() - t0).toBeLessThan(5000)
})

test('startApp rejects with the log when the child exits before ready', async () => {
  await expect(startApp({ ...fake('fake-server.ts'), startCmd: () => ({ cmd: ['bun', '-e', 'console.log("boom"); process.exit(3)'], env: {} }) })).rejects.toThrow(/exited \(3\) before ready[\s\S]*boom/)
})

test('seeded shuffle is deterministic and a permutation', () => {
  const a = shuffle([1, 2, 3, 4, 5, 6], mulberry32(42))
  const b = shuffle([1, 2, 3, 4, 5, 6], mulberry32(42))
  expect(a).toEqual(b)
  expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6])
  expect(shuffle([1, 2, 3, 4, 5, 6], mulberry32(7))).not.toEqual(a)
})

test('a busy port is refused by name and the foreign listener is left alone', async () => {
  const foreign = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('still here') })
  try {
    expect(await portInUse(foreign.port!)).toBe(true)
    await expect(startApp({ ...fake('fake-server.ts'), port: foreign.port! })).rejects.toThrow(/already in use by another process[\s\S]*not killing it/)
    expect(await (await fetch(`http://127.0.0.1:${foreign.port}/`)).text()).toBe('still here')
  } finally {
    foreign.stop(true)
  }
  expect(await portInUse(foreign.port!)).toBe(false)
})

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

test('stop() signals only the spawned process group: a foreign process survives, the grandchild does not', async () => {
  const foreign = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const app = await startApp(fake('spawns-grandchild.ts'))
    const gc = Number(/grandchild (\d+)/.exec(app.log())![1])
    expect(alive(gc)).toBe(true)
    await app.stop()
    await Bun.sleep(200)
    expect(alive(gc)).toBe(false)
    expect(alive(app.proc.pid)).toBe(false)
    expect(alive(foreign.pid)).toBe(true)
  } finally {
    foreign.kill('SIGKILL')
  }
})
