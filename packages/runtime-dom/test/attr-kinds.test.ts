// F201: the runtime's x-bind-* prints a value on an attribute the way React does, for every attribute kind the
// compiler classifies (crates/brust-jinja `attr_kind`). One table: attr-kinds.ts is generated from the Rust lists.
import { expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineBehavior, mount, unmount } from '../src'
import { BOOLEAN, OVERLOADED, STRINGIFY } from '../src/attr-kinds'
import { checkNames, generate, table } from '../../../scripts/gen-attr-kinds'

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

test('the generator refuses a name outside ^[a-z][a-z0-9-]*$ (F212)', () => {
  expect(checkNames('T', ['loop', 'aria-busy', 'x1'])).toEqual(['loop', 'aria-busy', 'x1'])
  for (const bad of ["a'b", 'a b', 'A', '1a', '', 'a\\b', 'a;b', "a'); alert(1); ('"]) expect(() => checkNames('T', [bad])).toThrow('outside')
  // and the real tables pass it
  expect(() => generate()).not.toThrow()
})

const custom = JSON.parse(readFileSync(join(root, 'tests/fixtures/attr-parity/react-custom.json'), 'utf8')) as Record<string, Record<string, string>>

test('x-bind-<attr> on a custom element equals react-dom: every attribute passes through, true is "" (F213)', () => {
  const bad: string[] = []
  for (const n of Object.keys(custom).filter((k) => k !== 'value')) {
    for (const [label, v] of Object.entries(VALUES)) {
      unmount()
      defineBehavior('c', () => ({ v }))
      document.body.innerHTML = `<div x-data="c"><x-y x-bind-${n.toLowerCase()}="v"></x-y></div>`
      mount()
      const el = document.querySelector('x-y')!
      const want = document.createElement('div'); want.innerHTML = `<x-y ${custom[n]![label]}></x-y>`
      const attrs = (e: Element) => JSON.stringify(Object.fromEntries([...e.attributes].filter((a) => !a.name.startsWith('x-')).map((a) => [a.name, a.value])))
      if (attrs(want.firstElementChild!) !== attrs(el)) bad.push(`${n}=${label}: react ${attrs(want.firstElementChild!)} got ${attrs(el)}`)
    }
  }
  expect(bad).toEqual([])
})
