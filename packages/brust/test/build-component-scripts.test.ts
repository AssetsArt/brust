// F591: `[build] component_scripts` and the manifest's `hosts` (which native chunks a response may leave out).
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Compiled } from '../src/build/compile'
import { loadBuildConfig, parseComponentScripts } from '../src/build/config'
import { chunkHosts } from '../src/build/manifest'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const app = (toml: string) => {
  const d = mkdtempSync(join(tmpdir(), 'brust-f591-'))
  dirs.push(d)
  writeFileSync(join(d, 'brust.toml'), toml)
  return d
}

test('[build] component_scripts is "drawn" (the default) or "route"', async () => {
  expect(parseComponentScripts('brust.toml', undefined)).toBe('drawn')
  expect(parseComponentScripts('brust.toml', 'drawn')).toBe('drawn')
  expect(parseComponentScripts('brust.toml', 'route')).toBe('route')
  for (const v of ['all', '', true, 1, ['route']]) expect(() => parseComponentScripts('brust.toml', v)).toThrow(/build\.component_scripts must be "drawn" or "route"/)
  expect((await loadBuildConfig(app('[build]\ncomponent_scripts = "route"\n'))).componentScripts).toBe('route')
  expect((await loadBuildConfig(app('[server]\nport = 3000\n'))).componentScripts).toBe('drawn')
  await expect(loadBuildConfig(app('[build]\ncomponent_scripts = "page"\n'))).rejects.toMatchObject({ rule: 'config' })
})

const comp = (id: string, o: { tier?: 'Native' | 'Static' | 'React'; jinja?: string; js?: string | null } = {}): Compiled =>
  ({
    id,
    file: `/app/${id}.tsx`,
    ir: { id, tier: o.tier === 'React' ? { React: {} } : (o.tier ?? 'Native') },
    jinja: o.jinja ?? `<b x-data="${id}"></b>`,
    ...(o.js === null ? {} : { clientJs: o.js ?? `export default defineBehavior(${JSON.stringify(id)}, b)` }),
  }) as unknown as Compiled

function hosts(list: Compiled[], graph: Record<string, string[]>, unclean: string[] = []) {
  const compiled = new Map(list.map((c) => [c.id, c]))
  const chunks = new Map(list.filter((c) => c.clientJs !== undefined).map((c) => [c.id, `client/${c.id}-0.js`]))
  return chunkHosts({
    compiled,
    chunks,
    graph: new Map(Object.entries(graph).map(([k, v]) => [k, new Set(v)])),
    isApp: (f) => f.startsWith('/app/') && !f.includes('/node_modules/'),
    clean: (f) => !unclean.includes(f),
  })
}

test('a compiler-made native chunk whose host is printed gets hosts = [its id]', () => {
  const got = hosts([comp('a_1'), comp('b_2', { jinja: '<i></i>' }), comp('p_3', { tier: 'Static', jinja: '<b x-data="b_2"></b>', js: null })], { a_1: ['/app/.stage/a_1.js'], b_2: [] })
  expect([...got]).toEqual([
    ['a_1', ['a_1']],
    ['b_2', ['b_2']],
  ])
})

test('no hosts: a React chunk, a host never printed, a chunk that does not name its id, no bundle graph', () => {
  const got = hosts(
    [comp('r_1', { tier: 'React' }), comp('n_2', { jinja: '<i></i>' }), comp('m_3', { js: 'export default defineBehavior(other, b)' }), comp('g_4')],
    { r_1: [], n_2: [], m_3: [] },
  )
  expect([...got]).toEqual([])
})

test('an x-data value that is not a plain name proves nothing: no chunk gets hosts', () => {
  expect([...hosts([comp('a_1'), comp('p_2', { tier: 'Static', jinja: '<b x-data="{{ name }}"></b>', js: null })], { a_1: [] })]).toEqual([])
})

test('rule e: a bundled app script that is not load-clean keeps the chunk; packages and data files do not', () => {
  const graph = {
    a_1: ['/app/lib/tidy.ts', '/app/node_modules/pkg/index.js', '/app/x.module.css', '/app/data.json'],
    b_2: ['/app/lib/busy.ts'],
    c_3: ['/app/node_modules/pkg/side.js'],
  }
  const unclean = ['/app/lib/busy.ts', '/app/node_modules/pkg/side.js', '/app/x.module.css', '/app/data.json', '/app/node_modules/pkg/index.js']
  expect([...hosts([comp('a_1'), comp('b_2'), comp('c_3')], graph, unclean).keys()]).toEqual(['a_1', 'c_3'])
})
