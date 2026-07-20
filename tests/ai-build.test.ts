import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const dirs: string[] = []
const processes: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(async () => {
  for (const proc of processes.splice(0)) {
    proc.kill('SIGINT')
    await proc.exited
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function productionEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && key !== 'BRUST_AI' && key !== 'BRUST_DEV',
      ) as Array<[string, string]>,
    ),
    ...extra,
  }
}

async function makeApp(aiOption: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'brust-ai-build-'))
  dirs.push(dir)
  const nodeModules = path.join(dir, 'node_modules')
  await mkdir(nodeModules)
  await symlink(REPO, path.join(nodeModules, 'brustjs'), 'dir')
  await symlink(path.join(REPO, 'node_modules/react'), path.join(nodeModules, 'react'), 'dir')
  await symlink(
    path.join(REPO, 'node_modules/react-dom'),
    path.join(nodeModules, 'react-dom'),
    'dir',
  )
  await writeFile(
    path.join(dir, 'index.ts'),
    `import { brust } from 'brustjs'\nimport { routes } from './routes'\nawait brust.run({ routes, entry: import.meta.url${aiOption} })\n`,
  )
  await writeFile(
    path.join(dir, 'routes.tsx'),
    `import { defineRoutes } from 'brustjs/routes'\nimport Home from './Home'\nexport const routes = defineRoutes([{ path: '/', Component: Home, native: true }] as const)\n`,
  )
  await writeFile(
    path.join(dir, 'Home.tsx'),
    `export default function Home() { return <html><head><title>AI build</title></head><body><main>ready</main></body></html> }\n`,
  )
  return dir
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('node:net').AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(300),
      })
      if (response.status === 200) return
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error(`server on port ${port} did not become ready`)
}

test('literal run({ ai: true }) enables a clean production AI build without --ai', async () => {
  const appDir = await makeApp(', ai: true')
  const distDir = path.join(appDir, 'dist')
  const build = Bun.spawn({
    cmd: [
      'bun',
      path.join(REPO, 'runtime/cli/index.ts'),
      'build',
      'index.ts',
      '--out-dir',
      distDir,
    ],
    cwd: appDir,
    env: productionEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [buildExit, buildStderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ])
  expect(buildExit, buildStderr).toBe(0)
  expect(existsSync(path.join(distDir, 'islands/ai.js'))).toBe(true)

  const bundle = await Bun.file(path.join(distDir, 'index.js')).text()
  expect(bundle).toContain("process.env.BRUST_AI ??= '1'")
  expect(bundle).not.toContain("process.env.BRUST_DEV ??= '1'")

  const nativeTemplate = await Bun.file(path.join(distDir, 'jinja/Home.jinja')).text()
  expect(nativeTemplate).toContain('/_brust/ai.js')
  expect(nativeTemplate).not.toContain('/_brust/dev')
  expect(nativeTemplate).not.toContain('__brust_dev_overlay')

  const port = await freePort()
  const proc = Bun.spawn({
    cmd: ['bun', 'run', path.join(distDir, 'index.js')],
    cwd: appDir,
    env: productionEnv({ BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  processes.push(proc)
  await waitForServer(port)

  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  expect(html).toContain('/_brust/ai.js')
  expect(html).not.toContain('/_brust/dev')
  expect(html).not.toContain('__brust_dev_overlay')

  expect((await fetch(`http://127.0.0.1:${port}/_brust/ai.js`)).status).toBe(200)
  expect((await fetch(`http://127.0.0.1:${port}/_brust/ai/manifest.json`)).status).toBe(200)
  expect((await fetch(`http://127.0.0.1:${port}/_brust/dev`)).status).toBe(404)

  const react = await fetch(`http://127.0.0.1:${port}/_brust/islands/_react.js`)
  expect(react.status).toBe(200)
  expect(react.headers.get('cache-control')).toBe('public, max-age=3600')
}, 60_000)

test('a disabled production build retains zero AI and dev-client output', async () => {
  const appDir = await makeApp('')
  const distDir = path.join(appDir, 'dist')
  const build = Bun.spawn({
    cmd: [
      'bun',
      path.join(REPO, 'runtime/cli/index.ts'),
      'build',
      'index.ts',
      '--out-dir',
      distDir,
    ],
    cwd: appDir,
    env: productionEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [buildExit, buildStderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ])
  expect(buildExit, buildStderr).toBe(0)
  expect(existsSync(path.join(distDir, 'islands/ai.js'))).toBe(false)

  const bundle = await Bun.file(path.join(distDir, 'index.js')).text()
  expect(bundle).not.toContain("process.env.BRUST_AI ??= '1'")
  expect(bundle).not.toContain("process.env.BRUST_DEV ??= '1'")

  const nativeTemplate = await Bun.file(path.join(distDir, 'jinja/Home.jinja')).text()
  expect(nativeTemplate).not.toContain('/_brust/ai.js')
  expect(nativeTemplate).not.toContain('/_brust/dev')
  expect(nativeTemplate).not.toContain('__brust_dev_overlay')

  const port = await freePort()
  const proc = Bun.spawn({
    cmd: ['bun', 'run', path.join(distDir, 'index.js')],
    cwd: appDir,
    env: productionEnv({ BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  processes.push(proc)
  await waitForServer(port)

  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  expect(html).not.toContain('/_brust/ai.js')
  expect(html).not.toContain('/_brust/dev')
  expect(html).not.toContain('__brust_dev_overlay')
  expect((await fetch(`http://127.0.0.1:${port}/_brust/ai.js`)).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${port}/_brust/ai/manifest.json`)).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${port}/_brust/dev`)).status).toBe(404)
}, 60_000)
