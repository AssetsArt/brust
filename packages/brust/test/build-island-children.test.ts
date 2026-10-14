// shadcn S1 (R34.21–R34.22): a page that hands constant JSX children to React islands stays static; each island's
// chunk and the SSR job import the components inside the tree and revive it. Hydration is
// `tests/server/island-children.chromium.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { islandShim, nestedOf, reviveSource } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'

const app = join(import.meta.dir, 'fixtures/island-children')
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

test('the page stays static; the islands carry their children', async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {}, force: true })
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const tiers = Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier])
  expect(Object.fromEntries(tiers).page).toBe('static')
  expect(tiers.filter(([, t]) => t === 'react').map(([id]) => id)).toContain('disclosure')
  const jobs = readFileSync(join(dist, 'jobs.js'), 'utf8')
  expect(jobs).toContain('$brust')
  // The island chunk revives the tree: its entry names the components the page puts inside.
  const chunk = readdirSync(join(dist, 'client')).find((f) => f.startsWith('react-disclosure_'))!
  const code = readFileSync(join(dist, 'client', chunk), 'utf8')
  expect(code).toContain('$brust')
  expect(code).toMatch(/trigger_[0-9a-f]{8}/)
})

test('the island entry and the SSR job use one revive', () => {
  const src = reviveSource('{}')
  expect(src).toContain("n.$brust === 'cmp'")
  const host = { id: 'host_1', file: '/app/h.tsx', ir: { tier: { React: {} }, export: 'Host' } } as unknown as Compiled
  const part = { id: 'part_1', file: '/app/p.tsx', ir: { tier: 'Static', export: 'Part' } } as unknown as Compiled
  const page = { id: 'page_1', file: '/app/page.tsx', ir: { tier: 'Static', children: [{ name: 'Host', id: 'host_1', nested: ['part_1'] }] } } as unknown as Compiled
  const compiled = new Map([host, part, page].map((c) => [c.id, c]))
  expect(nestedOf(compiled, 'host_1')).toEqual(['part_1'])
  expect(nestedOf(compiled, 'part_1')).toBeUndefined()
  const shim = islandShim(host, compiled)
  expect(shim).toContain('import { Part as N0 } from "/app/p.tsx"')
  expect(shim).toContain('__mk(Comp, props, [])')
  // An island nothing passes children to keeps the plain entry.
  expect(islandShim(host)).toContain('createElement(Comp, props)')
})

test('revive reads the tree as untrusted (R34.26)', async () => {
  const dir = join(import.meta.dir, 'fixtures/island-children')
  const file = join(dir, `revive-probe-${process.pid}.tsx`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, `import { createElement, Fragment } from 'react'\n${reviveSource("{ ok: (p: any) => createElement('i', null, p.x) }")}\nexport { __mk }\n`)
  try {
    const { __mk } = await import(file)
    const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
    const renderToString = (el: unknown) => server.renderToString(el)
    const html = (children: unknown) => renderToString(__mk('section', { children }))
    expect(html({ $brust: 'cmp', id: 'ok', p: { x: 'fine' }, c: [] })).toBe('<section><i>fine</i></section>')
    // A tag that is not a plain element name, an id that is not an own registry key, an unmarked object: all throw.
    expect(() => html({ $brust: 'el', t: 'img src=x onerror=alert(1)', p: {}, c: [] })).toThrow('invalid element name')
    expect(() => html({ $brust: 'el', t: ['a'], p: {}, c: [] })).toThrow('invalid element name')
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(() => html({ $brust: 'cmp', id, p: {}, c: [] })).toThrow('does not import')
    expect(() => html({ plain: 'object' })).toThrow('unknown node')
    // Raw HTML, `ref`, `key` and `__proto__` never reach an element from the tree.
    const out = html({ $brust: 'el', t: 'div', p: JSON.parse('{"dangerouslySetInnerHTML":{"__html":"<script>1</script>"},"__proto__":{"polluted":true},"id":"d"}'), c: ['t'] })
    expect(out).toBe('<section><div id="d">t</div></section>')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    // A `javascript:` URL goes through React's own guard, as it does in hand-written JSX.
    expect(html({ $brust: 'el', t: 'a', p: { href: 'javascript:alert(1)' }, c: ['x'] })).not.toContain('href="javascript:alert(1)"')
    // `</script>` in text is escaped by React in the markup, and by the island props embedding in x-props.
    expect(html('</script><b>')).toBe('<section>&lt;/script&gt;&lt;b&gt;</section>')
  } finally {
    rmSync(file, { force: true })
  }
})
