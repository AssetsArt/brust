// F404: `const [c] = useState(children)` printed nothing where React prints the child. The compiler refuses the
// component by name (`state-from-children`), so it is a React island and the served page equals React's output.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import Seeded from './fixtures/state-from-children/Seeded'

const app = join(import.meta.dir, 'fixtures/state-from-children')
const bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let html = ''

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/listening on|\[brust\] ready/.test(log)) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`brust start exited:\n${log}`)
    log += dec.decode(value)
  }
  const base = /(https?:\/\/[^\s]+:\d+)/.exec(log)?.[1] ?? `http://127.0.0.1:${/:(\d+)/.exec(log)![1]}`
  html = await (await fetch(`${base}/`)).text()
}, 120_000)

afterAll(() => {
  proc?.kill()
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('the served page prints the child the state was seeded from, as React does', () => {
  const react = renderToString(createElement(Seeded, null, 'hello ', createElement('b', null, 'world')))
  const bare = (h: string) => h.replace(/<!--.*?-->/g, '')
  expect(bare(react)).toBe('<div id="seeded">hello <b>world</b></div>')
  expect(bare(html)).toContain(bare(react))
})

test('the component is a React island and the counter beside it is still native', () => {
  expect(html).toContain('<brust-island')
  expect(html).toContain('id="count"')
  expect(html).toContain('x-data=')
})
