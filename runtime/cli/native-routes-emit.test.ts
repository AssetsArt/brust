import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
import { reconcileIslandManifest } from './native-routes-emit.ts'

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `brust-t6-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reconcileIslandManifest', () => {
  test('enriches each .islands.json entry with sourcePath from the config map', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([{ id: 'Counter', propsPath: 'data.x', ssr: false, hydrate: 'load' }]),
    )

    reconcileIslandManifest(jinjaPath, islandsJsonPath, { Counter: '/abs/Counter.tsx' }, 'Page')

    const enriched = JSON.parse(readFileSync(islandsJsonPath, 'utf8'))
    expect(enriched).toEqual([
      {
        id: 'Counter',
        propsPath: 'data.x',
        ssr: false,
        hydrate: 'load',
        sourcePath: '/abs/Counter.tsx',
      },
    ])
  })

  test('appends the {% raw %}-wrapped bootstrap to the .jinja file', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    const original = '<div>hi</div>'
    writeFileSync(jinjaPath, original)
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([{ id: 'Counter', propsPath: 'data.x', ssr: false, hydrate: 'load' }]),
    )

    reconcileIslandManifest(jinjaPath, islandsJsonPath, { Counter: '/abs/Counter.tsx' }, 'Page')

    const content = readFileSync(jinjaPath, 'utf8')
    const expectedTail = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
    expect(content).toBe(original + expectedTail)
    expect(content.endsWith(expectedTail)).toBe(true)
    expect(content).toContain('{% raw %}<script type="importmap">')
    expect(content).toContain('{% endraw %}')
  })

  test('preserves the literal }} from the importmap JSON verbatim inside {% raw %}', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([{ id: 'Counter', propsPath: 'data.x', ssr: false, hydrate: 'load' }]),
    )

    reconcileIslandManifest(jinjaPath, islandsJsonPath, { Counter: '/abs/Counter.tsx' }, 'Page')

    const content = readFileSync(jinjaPath, 'utf8')
    // The importmap JSON ends with `}}` (closing imports + root object). That
    // sequence must survive verbatim in the baked .jinja.
    expect(content).toContain('}}</script>')
  })

  test('throws when an id is not registered in the config map (message contains id + route)', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([{ id: 'Ghost', propsPath: 'data.x', ssr: false, hydrate: 'load' }]),
    )

    expect(() =>
      reconcileIslandManifest(jinjaPath, islandsJsonPath, { Counter: '/abs/Counter.tsx' }, 'Page'),
    ).toThrow(/Ghost.*Page|Page.*Ghost/)
  })

  test('no .islands.json → .jinja is byte-identical and no error even with undefined map', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    const original = '<html><body>{{ greeting }}</body></html>'
    writeFileSync(jinjaPath, original)
    // No islands.json written.
    expect(existsSync(islandsJsonPath)).toBe(false)

    expect(() =>
      reconcileIslandManifest(jinjaPath, islandsJsonPath, undefined, 'Page'),
    ).not.toThrow()

    expect(readFileSync(jinjaPath, 'utf8')).toBe(original)
    expect(existsSync(islandsJsonPath)).toBe(false)
  })
})
