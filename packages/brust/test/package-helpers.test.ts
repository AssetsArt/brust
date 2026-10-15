// F197: a helper imported from a package and called as a child of a plain wrapper is proven plain from the package
// source the build writes (`.brust/pkg-src`, from the source map), so the page lowers instead of falling back to React,
// and serves the HTML React renders. A tiny local package stands in for a published one (no network).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installPlainFmt } from './fixtures/package-helpers/install'

const root = join(import.meta.dir, 'fixtures/package-helpers')
const app = join(root, 'app')
const bin = join(import.meta.dir, '../bin/brust')
let uninstall: () => void
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''

beforeAll(async () => {
  uninstall = installPlainFmt(root)
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', 'dist'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', 'dist', '--entry', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
}, 120_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  rmSync(join(app, '.brust'), { recursive: true, force: true })
  uninstall?.()
})

test('the package helpers are proven plain: the page lowers (no React island)', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist', 'manifest.json'), 'utf8')) as {
    components: Record<string, { tier: string }>
  }
  const page = Object.entries(m.components).find(([id]) => id.startsWith('page'))![1]
  expect(page.tier).not.toBe('react')
})

test('the served HTML is what React renders', async () => {
  const html = await (await fetch(`${base}/`)).text()
  expect(html).not.toContain('<brust-island')
  const code = `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import Page from './Page'; process.stdout.write(renderToStaticMarkup(createElement(Page)))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  const react = r.stdout.toString()
  expect(react).toBe('<section><b>#3</b><i>HI</i></section>')
  expect(html).toContain(react)
})
