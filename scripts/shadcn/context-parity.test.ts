// S2 (R34.103, R34.113): pages that use Radix's own context-based primitives (`Progress.Root` / `Progress.Indicator`, built
// from the PUBLISHED package source) render the same DOM as the real React build. The brust side is a real build served by
// `brust start`; the React side is `renderToStaticMarkup` of the same page. Pages are repro files, not scoreboard rows.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE, repo } from './paths.ts'

const PAGES = ['ctx-progress-basic', 'ctx-progress-max', 'ctx-progress-indeterminate', 'ctx-progress-invalid']
// F3: islands under a Provider keep the page React (the island hydrates, so scripts are expected and markup is React's own).
const ISLAND_PAGES = ['ctx-island-same', 'ctx-island-cross', 'ctx-jsx-const-wrap', 'ctx-jsx-const-provider', 'ctx-imp-wrap', 'ctx-imp-provider', 'ctx-imp-ns', 'ctx-imp-cond-and', 'ctx-imp-cond-tern']
// Imported plain value: stays a static page (no script), and renders like React.
const PLAIN_PAGES = ['ctx-imp-plain']
const ROWS = join(FIXTURE, '.rows')
const ENTRY = '.rows/ctx-parity-routes.tsx'
const bin = join(repo, 'packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''

// The fixture's own react / react-dom (the same instance the page modules import).
const fromFixture = <T>(spec: string) => import(Bun.resolveSync(spec, FIXTURE)) as Promise<T>
const camel = (s: string) => s.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())

beforeAll(async () => {
  mkdirSync(ROWS, { recursive: true })
  const ALL = [...PAGES, ...ISLAND_PAGES, ...PLAIN_PAGES]
  const imports = ALL.map((p) => `import ${camel(p)}Page from "../repro/${p}"`).join('\n')
  const routes = ALL.map((p) => `  { path: "/${p}", Component: ${camel(p)}Page },`).join('\n')
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\n${imports}\nexport const routes = defineRoutes([\n${routes}\n])\n`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', '.rows/dist-ctx-parity'], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', '.rows/dist-ctx-parity', '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
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
}, 180_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])
    if (exited === undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(ROWS, 'dist-ctx-parity'), { recursive: true, force: true })
})

/** The elements of a markup string as `tag{sorted attrs}` plus text, so attribute order is not compared. */
function normalise(html: string): string {
  const body = (/<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? html)
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*data-brust-css[^>]*>/g, '') // the server's stylesheet link, not the page
    .replaceAll('&#x27;', '&#39;') // React and brust spell the same apostrophe differently
  return body
    .replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_, tag: string, attrs: string, close: string) => {
      const list = [...attrs.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)].map((m) => `${m[1]}=${m[2] ?? ''}`).sort()
      return `<${tag} ${list.join(' ')}${close}>`
    })
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
}

for (const id of [...PAGES, ...PLAIN_PAGES]) {
  test(`${id}: the compiled page renders the DOM the React build renders`, async () => {
    const mod = (await import(join(FIXTURE, 'repro', `${id}.tsx`))) as { default: () => unknown }
    const { renderToStaticMarkup } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
    const { createElement } = await fromFixture<typeof import('react')>('react')
    const react = normalise(renderToStaticMarkup(createElement(mod.default as never)))
    const r = await fetch(`${base}/${id}`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).not.toMatch(/<script[^>]+src=/) // a static page ships no component JS
    expect(normalise(html)).toContain(react)
  }, 60_000)
}

const plain = (h: string) => normalise(h.replace(/<!-- -->/g, ''))
for (const id of ISLAND_PAGES) {
  test(`${id}: the page (island under a Provider, JSX const child) renders exactly as React does`, async () => {
    const mod = (await import(join(FIXTURE, 'repro', `${id}.tsx`))) as { default: () => unknown }
    const { renderToString } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
    const { createElement } = await fromFixture<typeof import('react')>('react')
    const react = plain(renderToString(createElement(mod.default as never)))
    const r = await fetch(`${base}/${id}`)
    expect(r.status).toBe(200)
    const html = plain(await r.text())
    expect(html).toContain(react)
    // The value React reads: the Provider's for the same-module island, the island module's own default for the other.
    if (id.startsWith('ctx-island')) {
      expect(html).toContain(id === 'ctx-island-same' ? 'from-panel' : 'default')
      expect(html).not.toContain(id === 'ctx-island-same' ? '>default<' : '>from-panel<')
    } else {
      expect(html).toMatch(/<b[^>]*>hi<\/b>/) // the dropped child is there
    }
  }, 60_000)
}
