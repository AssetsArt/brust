// S2 (R34.103, R34.113): pages that use Radix's own context-based primitives (`Progress.Root` / `Progress.Indicator`, built
// from the PUBLISHED package source) render the same DOM as the real React build. The brust side is a real build served by
// `brust start`; the React side is `renderToStaticMarkup` of the same page. Pages are repro files, not scoreboard rows.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE, repo } from './paths.ts'

const PAGES = ['ctx-progress-basic', 'ctx-progress-max', 'ctx-progress-indeterminate', 'ctx-progress-invalid']
// F3: islands under a Provider keep the page React (the island hydrates, so scripts are expected and markup is React's own).
const ISLAND_PAGES = ['ctx-island-same', 'ctx-island-cross', 'ctx-island-radix', 'ctx-page-collapsible', 'ctx-page-dialog', 'ctx-page-sheet', 'ctx-page-select', 'ctx-page-slider', 'ctx-page-toggle', 'ctx-page-toggle-onclick', 'ctx-page-checkbox', 'ctx-dlg-title', 'ctx-sheet-title', 'ctx-jsx-const-wrap', 'ctx-jsx-const-provider', 'ctx-imp-wrap', 'ctx-imp-provider', 'ctx-imp-ns',
  'ctx-imp-m-and', 'ctx-imp-m-computed', 'ctx-imp-m-index', 'ctx-imp-m-member', 'ctx-imp-m-nullish', 'ctx-imp-m-opt', 'ctx-imp-m-root', 'ctx-imp-m-template', 'ctx-imp-m-tern', 'ctx-loc-m-and', 'ctx-loc-m-computed', 'ctx-loc-m-index', 'ctx-loc-m-member', 'ctx-loc-m-nullish', 'ctx-loc-m-opt', 'ctx-loc-m-root', 'ctx-loc-m-template', 'ctx-loc-m-tern',
  'ctx-pown-imp-root', 'ctx-pown-imp-and', 'ctx-pown-imp-tern', 'ctx-pown-imp-member', 'ctx-pown-imp-index', 'ctx-pown-loc-root', 'ctx-pown-loc-and', 'ctx-pown-loc-tern', 'ctx-pown-loc-member', 'ctx-pown-loc-index',
  'ctx-plain-imp-root', 'ctx-plain-imp-and', 'ctx-plain-imp-tern', 'ctx-plain-loc-root', 'ctx-plain-loc-and', 'ctx-plain-loc-tern',
  // F173 + F190: under a plain wrapper an element read through a member, an index or an array, or returned by a helper, printed
  // nothing on main; the page is React now. Helpers their module cannot prove plain fall back the same way.
  'ctx-plain-imp-member', 'ctx-plain-imp-index', 'ctx-plain-imp-array', 'ctx-plain-imp-call', 'ctx-plain-loc-member', 'ctx-plain-loc-index', 'ctx-plain-loc-array', 'ctx-plain-loc-call',
  'ctx-plain-helper-index', 'ctx-plain-helper-member', 'ctx-plain-helper-let', 'ctx-plain-helper-ns',
  // Lead ruling on @57714ece: an allowlisted method on a user-defined receiver (a class instance, a shadowed Date, a
  // reassigned method), a computed name or an optional call keeps the page React.
  'ctx-plain-method-class', 'ctx-plain-method-date-shadow', 'ctx-plain-method-reassigned', 'ctx-plain-method-computed', 'ctx-plain-method-optional', 'ctx-plain-method-optional-call',
  // F198 + F199: the same element holders with no wrapper, and passed as a prop the child prints, printed the element's
  // internals on main (`{'key': None, 'props': …}`); the page is React now. A member of an imported object of a module
  // that holds elements falls back too (accepted loss).
  'ctx-top-imp-root', 'ctx-top-imp-and', 'ctx-top-imp-tern', 'ctx-top-imp-member', 'ctx-top-imp-index', 'ctx-top-imp-array', 'ctx-top-imp-call', 'ctx-top-loc-root', 'ctx-top-loc-and', 'ctx-top-loc-tern', 'ctx-top-loc-member', 'ctx-top-loc-index', 'ctx-top-loc-array', 'ctx-top-loc-call',
  'ctx-prop-imp-root', 'ctx-prop-imp-and', 'ctx-prop-imp-tern', 'ctx-prop-imp-member', 'ctx-prop-imp-index', 'ctx-prop-imp-array', 'ctx-prop-imp-call', 'ctx-prop-loc-root', 'ctx-prop-loc-and', 'ctx-prop-loc-tern', 'ctx-prop-loc-member', 'ctx-prop-loc-index', 'ctx-prop-loc-array', 'ctx-prop-loc-call', 'ctx-prop-loc-indirect', 'ctx-prop-loc-via-import', 'ctx-prop-loc-react', 'ctx-top-imp-object',
  // Mellow round 1: a parameter default, a destructured module binding, the comma operator, a state started with an element and
  // a loop over a list of elements.
  'ctx-top-param-default', 'ctx-top-param-pattern', 'ctx-top-pattern-binding', 'ctx-top-comma', 'ctx-top-state-element', 'ctx-top-loop-element',
  // F215: a module-level statement that changes a module binding is not in the copied code (main printed "a" for "a,b"
  // and "x" for "y"); the page is React now.
  'ctx-side-push', 'ctx-side-closure', 'ctx-side-init', 'ctx-side-writer', 'ctx-side-iife', 'ctx-side-method', 'ctx-side-import', 'ctx-side-param', 'ctx-side-import-call', 'ctx-side-pattern', 'ctx-side-coerce', 'ctx-side-later', 'ctx-side-getter', 'ctx-side-app-handed',
  'ctx-pprop-imp', 'ctx-pprop-loc', 'ctx-pfield-imp', 'ctx-pfield-loc', 'ctx-pframe-prop', 'ctx-pframe-call', 'ctx-hid-provfed', 'ctx-hid-bare',
]
// Imported plain value: stays a static page (no script), and renders like React.
// F173: the ordinary reads (a const map, .length, an imported helper proven plain in its module) lower under a wrapper AND
// under a Provider (ctx-trio-prov was React until F173 proved formatPrice).
// F198 + F199: ordinary reads with no wrapper and in props (a const map, a helper, `cn(…)`, an element-free local helper,
// an object spread) keep lowering.
const PLAIN_PAGES = ['ctx-imp-plain', 'ctx-trio-plain', 'ctx-trio-prov', 'ctx-plain-helper-ok', 'ctx-plain-attr-helper', 'ctx-plain-helper-string', 'ctx-plain-methods', 'ctx-top-ordinary', 'ctx-plain-f205', 'ctx-side-none']
// switch-provider-chain PR3: the scoreboard switch page compiles without React (Radix's Switch chain, its Thumb linked):
// no island, and the DOM equals React's once brust's own markers are set aside (directives `x-*`, the `display:
// contents` wrappers of a condition and of a host, a void element's `/>`).
const NATIVE_PAGES = ['ctx-page-switch']
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
  const ALL = [...PAGES, ...ISLAND_PAGES, ...PLAIN_PAGES, ...NATIVE_PAGES]
  const imports = ALL.map((p) => `import ${camel(p)}Page from "../repro/${p}"`).join('\n')
  const routes = ALL.map((p) => `  { path: "/${p}", Component: ${camel(p)}Page },`).join('\n')
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\n${imports}\nexport const routes = defineRoutes([\n${routes}\n])\n`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', '.rows/dist-ctx-parity'], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  // `bun test` renders the React side in UTC; the server must too (ctx-plain-methods prints dates and times).
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', TZ: 'UTC' }
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
    // A static page ships no component JS. The real Radix Progress pages were static (0 JS) until the Provider predicate
    // (lead ruling c) made them fall back: their Provider reads local helpers (isNumber, getProgressState) the allowlist
    // cannot prove yet (ledger F174), so they hydrate as a React island; the DOM must still equal React's.
    if (!id.startsWith('ctx-progress')) expect(html).not.toMatch(/<script[^>]+src=/)
    expect(normalise(html)).toContain(react)
  }, 60_000)
}

// useId differs only by the island's id prefix (R1, ruling 2bf3775a): the same id otherwise.
// brust's own host elements (`<brust-island>` around an island, `<brust-host style=display:contents>` around a native component
// that returns a fragment) and the `x-on-*` handler and `x-bind-*` attribute directives a compiled component carries (a Label's mousedown guard, a toggle's live `aria-pressed`) have no React equivalent and do not change the layout.
const plain = (h: string) => normalise(h.replace(/<!-- -->/g, '').replace(/<brust-island\b[^>]*>/g, '').replace(/<\/brust-island>/g, '').replace(/<brust-host\b[^>]*>/g, '').replace(/<\/brust-host>/g, '').replace(/ x-(?:on|bind)-[a-z-]+="?[\w$]+"?/g, '')).replace(/(radix-)_\w*R_(\d+)_/g, '$1_R_$2_')
// F388: the `<!--x-if-->` anchor before a hidden branch is brust's marker too (a `left && <X/>` keeps one for its
// falsy-left text).
const unmarked = (h: string) =>
  normalise(h.replace(/<\/?brust-(?:if|host)\b[^>]*>/g, '').replace(/<!--x-if-->/g, ''))
    .replace(/ x-[\w-]+=[^ >]*/g, '')
    .replace(/\/>/g, '>')
for (const id of NATIVE_PAGES) {
  test(`${id}: the page compiles without a React island and renders React's DOM`, async () => {
    const mod = (await import(join(FIXTURE, 'repro', `${id}.tsx`))) as { default: () => unknown }
    const { renderToStaticMarkup } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
    const { createElement } = await fromFixture<typeof import('react')>('react')
    const react = unmarked(renderToStaticMarkup(createElement(mod.default as never)))
    const r = await fetch(`${base}/${id}`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).not.toContain('brust-island')
    expect(unmarked(html)).toContain(react)
  }, 60_000)
}

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
    if (id.startsWith('ctx-page-') || id.endsWith('-title')) {
      expect(html).toContain('data-slot=')
    } else if (id === 'ctx-island-radix') {
      expect(html).toContain('<button aria-expanded=false data-slot=trigger data-state=closed type=button>Toggle</button>')
    } else if (id.startsWith('ctx-island')) {
      expect(html).toContain(id === 'ctx-island-same' ? 'from-panel' : 'default')
      expect(html).not.toContain(id === 'ctx-island-same' ? '>default<' : '>from-panel<')
    } else if (id.startsWith('ctx-hid-')) {
      expect(html).toContain('lit') // React reads the context value, never the forged prop
      expect(html).not.toContain('forged')
    } else if (id.startsWith('ctx-side-')) {
      // The value React computes after the module's own statements ran.
      expect(html).toMatch(id === 'ctx-side-closure' ? /<section ?>y<\/section>/ : id === 'ctx-side-param' || id === 'ctx-side-later' || id === 'ctx-side-app-handed' ? /<section ?>b<\/section>/ : /<section ?>a,b<\/section>/)
    } else if (id.startsWith('ctx-plain-helper-') || /^ctx-plain-method-(computed|optional)/.test(id) || id === 'ctx-top-imp-object') {
      // React's own markup is the check (`toContain(react)` above): the helper's value, not an element.
    } else {
      // The dropped child is there. A template literal of an element is React's own "[object Object]" text.
      expect(html).toMatch(id.endsWith('-template') ? /\[object Object\]/ : /<b[^>]*>hi<\/b>/)
    }
  }, 60_000)
}
