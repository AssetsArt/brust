// shadcn S1 (R34.50-R34.52): lists, constant conditions and element-valued props inside the children of a React island
// are folded by the compiler; the page stays static and the island chunk and the SSR job revive the trees. Hydration is
// `tests/server/island-slots.chromium.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { runBuild } from '../src/build'
import { islandShim, nestedOf, reviveSource } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'

const app = join(import.meta.dir, 'fixtures/island-slots')
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

test('the page stays static; the islands carry unrolled lists and an element prop', async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {}, force: true })
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
  expect(tiers.page).toBe('static')
  expect(tiers.tip).toBe('react')
  // Both instances carry their folded list rows and name the element prop in `$x` (manifest jobs and the page template).
  const template = readFileSync(join(dist, 'jinja', readdirSync(join(dist, 'jinja')).find((f) => f.startsWith('page_'))!), 'utf8')
  expect(template).toContain('v1.0.4')
  expect(template).toContain('$x')
  expect(readFileSync(join(dist, 'jobs.js'), 'utf8')).toContain('__xs(rest,')
  const chunk = readdirSync(join(dist, 'client')).find((f) => f.startsWith('react-tip_'))!
  const code = readFileSync(join(dist, 'client', chunk), 'utf8')
  expect(code).toContain('$x')
})

test('only the names the compiler lists are revived; data is never a marker (R34.52)', async () => {
  const file = join(import.meta.dir, 'fixtures/island-slots', `revive-probe-${process.pid}.tsx`)
  writeFileSync(file, `import { createElement, Fragment } from 'react'\n${reviveSource("{ ok: (p: any) => createElement('i', null, p.x ?? 'ok') }")}\nexport { __mk, __rv }\n`)
  try {
    const { __mk } = await import(file)
    const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
    const Show = (p: { content?: unknown; data?: unknown }) => createElement('b', null, (p.content ?? null) as never, typeof p.data === 'object' ? JSON.stringify(p.data) : null)
    const html = (props: Record<string, unknown>) => server.renderToString(__mk(Show, props, ['content', 'data']))
    const marker = { $brust: 'el', t: 'u', p: {}, c: ['hi'] }
    // Listed in `$x`: revived.
    expect(html({ content: marker, $x: ['content'] })).toContain('<u>hi</u>')
    // Not listed: a data prop that looks like a marker stays data (it is JSON, not elements).
    const plain = html({ data: marker })
    expect(plain).not.toContain('<u>')
    expect(plain).toContain('&quot;$brust&quot;')
    // A forged `$x` naming a data prop that is not a marker throws instead of rendering it.
    expect(() => html({ data: { plain: 'object' }, $x: ['data'] })).toThrow('unknown node')
    // Names that start with `$` or that the revive strips are ignored, `$x` itself never reaches the component.
    expect(() => html({ content: marker, $x: ['$x', 'children', '__proto__', 'nope'] })).toThrow('Objects are not valid')
    // A forged marker still cannot name a component the island does not import, nor a bad tag.
    expect(() => html({ content: { $brust: 'cmp', id: 'evil', p: {}, c: [] }, $x: ['content'] })).toThrow('does not import')
    expect(() => html({ content: { $brust: 'el', t: 'img src=x', p: {}, c: [] }, $x: ['content'] })).toThrow('invalid element name')
    // A nested component's `x` revives its own element prop.
    expect(html({ content: { $brust: 'cmp', id: 'ok', p: { x: { $brust: 'el', t: 'q', p: {}, c: ['n'] } }, x: ['x'], c: [] }, $x: ['content'] })).toContain('<i><q>n</q></i>')
    // `x` on a component node cannot reach a prop that is not its own key, nor `children`.
    expect(html({ content: { $brust: 'cmp', id: 'ok', p: {}, x: ['children', 'missing'], c: [] }, $x: ['content'] })).toContain('<i>ok</i>')
  } finally {
    rmSync(file, { force: true })
  }
})

test('a call-site $x on an island is refused, so request data can never be revived (review F1)', async () => {
  const forged = join(import.meta.dir, 'fixtures/island-slots-forged')
  const out = join(forged, 'dist')
  const logs: string[] = []
  try {
    await runBuild({ appRoot: forged, entry: 'routes.tsx', outDir: out, log: (m: string) => logs.push(m), force: true })
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
    expect(tiers.page).toBe('react')
    // The island is the whole page: it renders `data` as data, with no revive code that reads a `$x`.
    for (const f of readdirSync(join(out, 'client'))) expect(readFileSync(join(out, 'client', f), 'utf8')).not.toContain('__xs')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a forged $x can only name what the compiler declared for the host (R34.71)', async () => {
  const file = join(import.meta.dir, 'fixtures/island-slots', `revive-allow-${process.pid}.tsx`)
  writeFileSync(file, `import { createElement, Fragment } from 'react'\n${reviveSource('{}')}\nexport { __mk }\n`)
  try {
    const { __mk } = await import(file)
    const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
    const Show = (p: { content?: unknown; data?: unknown }) => createElement('b', null, (p.content ?? null) as never, typeof p.data === 'object' ? JSON.stringify(p.data) : null)
    const marker = { $brust: 'el', t: 'u', p: {}, c: ['pwn'] }
    // `data` is a valid marker and is named by a forged `$x`, but the compiler never declared it: it stays text.
    const out = server.renderToString(__mk(Show, { data: marker, $x: ['data'] }, ['content']))
    expect(out).not.toContain('<u>')
    expect(out).toContain('&quot;$brust&quot;')
    // No declared names at all (the default): nothing revives.
    expect(server.renderToString(__mk(Show, { data: marker, $x: ['data'] }))).not.toContain('<u>')
    // A declared name still revives.
    expect(server.renderToString(__mk(Show, { content: marker, $x: ['content'] }, ['content']))).toContain('<u>pwn</u>')
  } finally {
    rmSync(file, { force: true })
  }
})

test('a reserved top-level key on a host throws; a $-key inside a value is data (R34.72)', async () => {
  const file = join(import.meta.dir, 'fixtures/island-slots', `revive-reserved-${process.pid}.tsx`)
  writeFileSync(file, `import { createElement, Fragment } from 'react'\n${reviveSource('{}')}\nexport { __mk }\n`)
  try {
    const { __mk } = await import(file)
    const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
    const Show = (p: { data?: unknown }) => createElement('b', null, JSON.stringify(p.data))
    expect(() => server.renderToString(__mk(Show, { $brust: 'el', data: 1 }, []))).toThrow('reserved key $brust')
    expect(() => server.renderToString(__mk(Show, { $other: 1 }, []))).toThrow('reserved key $other')
    // `$x` is the compiler's own and is fine; a `$` key nested in a value (Mongo-style `$oid`) is plain data.
    expect(server.renderToString(__mk(Show, { data: { $oid: 'abc' }, $x: [] }, []))).toContain('$oid')
  } finally {
    rmSync(file, { force: true })
  }
})

test('React neutralises javascript: in href, src, action and formAction at the pinned version (R34.73, F158 Q5)', async () => {
  const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
  const u = 'javascript:alert(1)'
  for (const [tag, props] of [
    ['a', { href: u }],
    ['img', { src: u }],
    ['form', { action: u }],
    ['button', { formAction: u }],
    ['a', { href: ' JaVa\tScript:alert(1)' }],
  ] as const) {
    const html = server.renderToString(createElement(tag, props))
    expect(html).toContain('React has blocked a javascript: URL')
    expect(html).not.toContain('alert(1)')
  }
})

test('a page that is also a host of JSX children: the caller falls back, the route component is never revived (R34.69-R34.70)', async () => {
  const route = join(import.meta.dir, 'fixtures/island-slots-route-host')
  const out = join(route, 'dist')
  const logs: string[] = []
  try {
    await runBuild({ appRoot: route, entry: 'routes.tsx', outDir: out, log: (m: string) => logs.push(m), force: true })
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
    expect(tiers.other).toBe('react')
    expect(tiers.shell).toBe('react')
    expect(logs.join('\n')).toContain('revive-host-route-root')
    // No revive code anywhere: Shell has no `__mk` entry, in the jobs bundle or in any island chunk.
    expect(readFileSync(join(out, 'jobs.js'), 'utf8')).not.toContain('__xs')
    for (const f of readdirSync(join(out, 'client'))) expect(readFileSync(join(out, 'client', f), 'utf8')).not.toContain('__xs')
    // The SSR job itself, fed hostile loader data (a marker, a `$x`, a `$brust` key): all of it is text.
    const jobs = (await import(join(out, 'jobs.js'))).default as Record<string, { ssr: (p: unknown) => string }>
    const id = Object.keys(manifest.components).find((k) => k.startsWith('shell_'))!
    const html = jobs[id]!.ssr({ title: 't', data: { $brust: 'el', t: 'u', p: {}, c: ['pwn'] }, $x: ['data'], children: 'plain' })
    expect(html).not.toContain('<u>')
    expect(html).toContain('&quot;$brust&quot;')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('element-only children still make an island a host; a route component never is, and its entry has no revive (R34.70)', () => {
  const comp = (id: string, children: unknown[] = []) =>
    ({ id, file: `/app/${id}.tsx`, ir: { export: 'default', tier: { React: { client_only: false } }, children }, jinja: '' }) as unknown as Compiled
  const host = comp('host')
  const caller = comp('caller', [{ id: 'host', nested: [], x: ['icon'] }])
  const map = new Map([['host', host], ['caller', caller]])
  // `nested: []` (a tree of plain elements) is a host: it was `undefined` and the island got raw JSON children.
  expect(nestedOf(map, 'host')).toEqual([])
  expect(islandShim(host, map)).toContain('__mk(Comp, props, ["icon"], [])')
  // A route component (page or layout) is not a host, whatever a caller did: plain createElement.
  const roots = new Set(['host'])
  expect(nestedOf(map, 'host', roots)).toBeUndefined()
  const shim = islandShim(host, map, roots)
  expect(shim).toContain('createElement(Comp, props)')
  expect(shim).not.toContain('__mk')
})
