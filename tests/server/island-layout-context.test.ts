// F437: a page that reads a context a layout above its route provides. The page imports the context (`useContext(Ctx)`), so
// it is not lowered (`hook-unsupported`) and ships as a React island; an island's SSR and hydrateRoot render it alone, without
// the layout's Provider, so it painted the createContext default where React paints the layout's value. The build now refuses
// it by name (`island-layout-context`, compile.ts `checkLayoutContexts`). Every other shape of the family fails closed as well
// (a Provider the layout cannot lower makes the layout itself an island: `outlet-in-react`), and a context nobody provides
// still reads its default, which is React's own answer. Run alone: `bun test --timeout 180000 tests/server/island-layout-context.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../packages/brust/test/fixtures/island-layout-context')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const procs: ReturnType<typeof Bun.spawn>[] = []
const shellEnv = () => {
  const { NODE_ENV: _n, ...rest } = process.env
  return { ...rest, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
}
const build = (v: string) => Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: join(root, v), env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })

afterAll(async () => {
  for (const p of procs) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { p.kill('SIGKILL'); await p.exited }
  }
  for (const v of ['layout', 'nested', 'state', 'shared', 'none']) rmSync(join(root, v, 'dist'), { recursive: true, force: true })
})

test('a context declared in the layout is refused for the island page, by name', () => {
  const b = build('layout')
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toContain('island-layout-context Page.tsx reads the context `Ctx`')
})

test('the same under a nested layout: the outer layout provides it', () => {
  const b = build('nested')
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toContain('island-layout-context Page.tsx reads the context `Ctx`')
  expect(b.stderr.toString()).toContain('Outer.tsx')
})

test('a Provider value that is layout state fails closed (the layout cannot be lowered)', () => {
  const b = build('state')
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toContain('outlet-in-react')
})

test('a context declared in a shared ctx.ts fails closed (the member tag is not resolved)', () => {
  const b = build('shared')
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toContain('outlet-in-react')
})

test('control: a context no layout provides still paints its default, like React', async () => {
  const b = build('none')
  expect(b.exitCode).toBe(0)
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: join(root, 'none'), env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  procs.push(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  const html = await (await fetch(`http://${/listening on (\S+)/.exec(out)![1]}/`)).text()
  expect(html).toContain('<p data-testid="v">dflt</p>')
}, 60_000)
