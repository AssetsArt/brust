// F201: the runtime's x-bind-* prints a value on an attribute the way React does, for every attribute kind the
// compiler classifies (crates/brust-jinja `attr_kind`). One table: attr-kinds.ts is generated from the Rust lists.
import { expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineBehavior, mount, unmount } from '../src'
import { BOOLEAN, OVERLOADED, STRINGIFY } from '../src/attr-kinds'
import { generate, table } from '../../../scripts/gen-attr-kinds'

beforeEach(() => { unmount(); document.body.innerHTML = '' })

const root = join(import.meta.dir, '../../..')

test('attr-kinds.ts is the generated copy of the brust-jinja tables, and they are the full React lists', () => {
  expect(readFileSync(join(root, 'packages/runtime-dom/src/attr-kinds.ts'), 'utf8')).toBe(generate())
  const rs = readFileSync(join(root, 'crates/brust-jinja/src/lib.rs'), 'utf8')
  expect([...BOOLEAN].sort()).toEqual(table(rs, 'BOOLEAN_ATTRS').sort())
  expect([...OVERLOADED].sort()).toEqual(table(rs, 'OVERLOADED_ATTRS').sort())
  expect([...STRINGIFY].sort()).toEqual(table(rs, 'STRINGIFY_ATTRS').sort())
  expect(BOOLEAN.size).toBe(28)
})

const react = JSON.parse(readFileSync(join(root, 'tests/fixtures/attr-parity/react.json'), 'utf8')) as Record<string, Record<string, string>>
const VALUES: Record<string, unknown> = { '0': 0, '1': 1, true: true, false: false, "''": '', null: null, undefined: undefined, "'x'": 'x' }
// `className` is the `class` special case and `value` an input property: both outside the attribute table.
const names = Object.keys(react).filter((n) => n !== 'className' && n !== 'value')

test('x-bind-<attr> after a client update equals react-dom for every name x value in the React fixture', () => {
  const bad: string[] = []
  for (const n of names) {
    const html = n.toLowerCase()
    for (const [label, v] of Object.entries(VALUES)) {
      unmount()
      defineBehavior('k', () => ({ v }))
      document.body.innerHTML = `<div x-data="k"><div x-bind-${html}="v"></div></div>`
      mount()
      const el = document.querySelector('[x-data]')!.firstElementChild!
      const want = document.createElement('div'); want.innerHTML = `<div ${react[n]![label]}></div>`
      const w = want.firstElementChild!
      const wantAttrs = Object.fromEntries([...w.attributes].map((a) => [a.name, a.value]))
      const gotAttrs = Object.fromEntries([...el.attributes].filter((a) => !a.name.startsWith('x-')).map((a) => [a.name, a.value]))
      if (JSON.stringify(wantAttrs) !== JSON.stringify(gotAttrs)) bad.push(`${n}=${label}: react ${JSON.stringify(wantAttrs)} got ${JSON.stringify(gotAttrs)}`)
    }
  }
  expect(bad).toEqual([])
})

test('src="" and href="" are dropped except on an anchor, SVG <a> included (F202)', () => {
  defineBehavior('e', () => ({ v: '' }))
  document.body.innerHTML = `<div x-data="e"><img id="i" x-bind-src="v"><a id="a" x-bind-href="v"></a><svg><a id="s" x-bind-href="v"></a></svg><link id="l" x-bind-href="v"></div>`
  mount()
  expect(document.getElementById('i')!.hasAttribute('src')).toBe(false)
  expect(document.getElementById('l')!.hasAttribute('href')).toBe(false)
  expect(document.getElementById('a')!.getAttribute('href')).toBe('')
  expect(document.getElementById('s')!.getAttribute('href')).toBe('')
})
