// F148a (R34.116-R34.119, R34.124): the hostile-input set for the revive. A value read from props fills a LEAF of the
// compiler's tree and nothing else: request data shaped like the compiler's own nodes renders as nothing, never as an
// element, a component, or a throw. Runs in the CI `bun test` of packages/brust.
import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { holesOf, islandShim, nestedOf, reviveSource } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'

const file = join(import.meta.dir, 'fixtures/island-children', `revive-holes-${process.pid}.tsx`)
const registry = "{ ok: (p: any) => createElement('i', { className: p.className }, p.children), danger: (p: any) => createElement('div', { dangerouslySetInnerHTML: p.dangerouslySetInnerHTML }) }"

async function load() {
  writeFileSync(file, `import { createElement, Fragment } from 'react'\n${reviveSource(registry)}\nexport { __mk }\n`)
  const { __mk } = await import(file)
  const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
  /** The tree under a <section>, with the island's props: `H` names its declared holes. */
  const render = (children: unknown, props: Record<string, unknown> = {}, H: string[] = Object.keys(props).filter((k) => /^\$[pc]\d+$/.test(k))) =>
    server.renderToString(__mk('section', { ...props, children }, [], H)).replaceAll('<!-- -->', '')
  return render
}

const v = (k: string) => ({ $brust: 'v', k })
const el = (t: string, p: Record<string, unknown>, c: unknown[]) => ({ $brust: 'el', t, p, c })

test('a primitive fills a text leaf and an attribute; escaping is React\'s', async () => {
  const render = await load()
  try {
    expect(render(el('p', { title: v('$p1') }, [v('$p0')]), { $p0: 'a </script><b>"q"', $p1: 'x"y' })).toBe(
      '<section><p title="x&quot;y">a &lt;/script&gt;&lt;b&gt;&quot;q&quot;</p></section>',
    )
    expect(render(el('p', {}, [v('$p0'), ' / ', v('$p1')]), { $p0: 7, $p1: 0 })).toBe('<section><p>7 / 0</p></section>')
    // An attribute may hold a boolean; a text leaf may not (React renders none either).
    expect(render(el('input', { disabled: v('$p0') }, []), { $p0: true })).toContain('disabled')
    expect(render(el('p', {}, [v('$p0')]), { $p0: true })).toBe('<section><p></p></section>')
  } finally {
    rmSync(file, { force: true })
  }
})

test('request data shaped like the compiler\'s nodes is never walked (R34.117)', async () => {
  const render = await load()
  try {
    const evil: unknown[] = [
      { $brust: 'el', t: 'script', c: ['window.__pwned = 1'] },
      { $brust: 'cmp', id: 'danger', p: { dangerouslySetInnerHTML: { __html: '<img src=x onerror=alert(1)>' } }, c: [] },
      { $brust: 'fr', c: ['x'] },
      { $brust: 'slot', k: '$c0' },
      { $brust: 'v', k: '$p0' },
      [{ $brust: 'el', t: 'b', c: ['x'] }],
      { a: 1 },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      null,
      undefined,
      Number.NaN,
    ]
    for (const e of evil) {
      // As text.
      const text = render(el('p', {}, [v('$p0')]), { $p0: e })
      expect(text, JSON.stringify(e)).not.toContain('<script')
      expect(text).not.toContain('<img')
      expect(text).not.toContain('<b>')
      expect(text).not.toContain('x</') // no fragment or element revived
      // As an attribute value: omitted.
      expect(render(el('p', { 'data-x': v('$p0') }, []), { $p0: e }), JSON.stringify(e)).toBe('<section><p></p></section>')
      // As a condition: its truthiness only, as in React; the value itself is never read into or revived.
      const asCondition = render({ $brust: 'if', k: '$p0', c: ['yes'], e: ['no'] }, { $p0: e })
      expect(asCondition, JSON.stringify(e)).toBe(e ? '<section>yes</section>' : '<section>no</section>')
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    // A `style` object from data is never applied: an object is not a primitive.
    expect(render(el('p', { style: v('$p0') }, ['t']), { $p0: { background: 'url(//evil.example/x)' } })).toBe('<section><p>t</p></section>')
  } finally {
    rmSync(file, { force: true })
  }
})

test('the hole names are the compiler\'s: anything else throws or renders nothing (R34.119)', async () => {
  const render = await load()
  try {
    // A `$` prop the host did not declare is rejected before rendering (R34.72); a declared one is not forwarded.
    expect(() => render(['x'], { $p9: 'a' }, [])).toThrow('reserved key $p9')
    expect(() => render(['x'], { $y: 'a' }, ['$p0'])).toThrow('reserved key $y')
    // A node cannot name a key the host did not declare, nor one that is not a hole name.
    expect(render(el('p', {}, [v('$p1')]), { $p0: 'secret' }, ['$p0'])).toBe('<section><p></p></section>')
    for (const k of ['constructor', '__proto__', 'toString', 'children', '$x', '$c0', 'p0']) {
      expect(render(el('p', {}, [v(k)]), { $p0: 'secret' }, ['$p0']), k).toBe('<section><p></p></section>')
    }
    // The component never sees a hole prop: `className` is read, `$p0` is not forwarded.
    expect(render({ $brust: 'cmp', id: 'ok', p: { className: v('$p0') }, c: ['t'] }, { $p0: 'k' })).toBe('<section><i class="k">t</i></section>')
    // `$x` still works for the compiler's element props.
    expect(() => render(['x'], { $x: ['a'] }, [])).not.toThrow()
  } finally {
    rmSync(file, { force: true })
  }
})

test('a condition renders what React renders, for every kind of value and both forms (F1)', async () => {
  const render = await load()
  const react = await import('react')
  const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
  try {
    const values: unknown[] = ['x', '', 'a b', 1, 0, -0, Number.NaN, true, false, null, undefined, {}, { a: 1 }, [], [0], { $brust: 'el', t: 'script' }]
    const yes = react.createElement('u', null, 'yes')
    const section = (child: unknown) => server.renderToString(react.createElement('section', null, child as any)).replaceAll('<!-- -->', '')
    for (const value of values) {
      const tag = `${typeof value} ${Object.is(value, -0) ? '-0' : JSON.stringify(value) ?? String(value)}`
      // `{v && <u>yes</u>}` (the node carries `a`): a falsy number is text, an empty string nothing.
      expect(render({ $brust: 'if', k: '$p0', c: [{ $brust: 'el', t: 'u', p: {}, c: ['yes'] }], e: [], a: true }, { $p0: value }), `&& ${tag}`).toBe(section(value && yes))
      // `{v ? <u>yes</u> : null}`: nothing for every falsy value, 0 included.
      expect(render({ $brust: 'if', k: '$p0', c: [{ $brust: 'el', t: 'u', p: {}, c: ['yes'] }], e: [] }, { $p0: value }), `?: ${tag}`).toBe(section(value ? yes : null))
      // With an else arm.
      expect(render({ $brust: 'if', k: '$p0', c: ['yes'], e: ['no'] }, { $p0: value }), `else ${tag}`).toBe(section(value ? 'yes' : 'no'))
    }
  } finally {
    rmSync(file, { force: true })
  }
})

test('a text hole renders what React renders for a string, a number and an array of them (F1)', async () => {
  const render = await load()
  const react = await import('react')
  const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
  try {
    const section = (child: unknown) => server.renderToString(react.createElement('section', null, child as any)).replaceAll('<!-- -->', '')
    for (const value of ['a', '', 'x </b>', 3, 0, true, false, null, undefined, ['a', 'b'], ['a', 2, 'c'], []]) {
      expect(render([{ $brust: 'v', k: '$p0' }], { $p0: value }), JSON.stringify(value) ?? 'undefined').toBe(section(value))
    }
    // An array of arrays or objects is not React-equivalent (it throws there): only the primitives are kept.
    expect(render([{ $brust: 'v', k: '$p0' }], { $p0: ['a', { $brust: 'el', t: 'script' }, ['b']] })).toBe('<section>a</section>')
  } finally {
    rmSync(file, { force: true })
  }
})

test('a caller\'s tree (slot) is revived once and holds no hole of its own', async () => {
  const render = await load()
  try {
    const tree = el('b', { title: v('$p0') }, [v('$p0'), 'x'])
    expect(render([{ $brust: 'slot', k: '$c0' }], { $c0: tree, $p0: 'secret' })).toBe('<section><b>x</b></section>')
    // A slot names a `$c` key only; a `$p` key, an undeclared key and a nested slot render nothing.
    expect(render([{ $brust: 'slot', k: '$p0' }], { $p0: tree })).toBe('<section></section>')
    expect(render([{ $brust: 'slot', k: '$c9' }], { $c0: tree })).toBe('<section></section>')
    expect(render([{ $brust: 'slot', k: '$c0' }], { $c0: { $brust: 'slot', k: '$c0' } })).toBe('<section></section>')
    // The tree is revived under the same rules as any other: a bad tag still throws.
    expect(() => render([{ $brust: 'slot', k: '$c0' }], { $c0: el('img src=x', {}, []) })).toThrow('invalid element name')
  } finally {
    rmSync(file, { force: true })
  }
})

test('URL attributes keep React\'s own javascript: guard when the value comes from a hole (R34.118)', async () => {
  const render = await load()
  try {
    for (const [tag, attr] of [['a', 'href'], ['img', 'src'], ['form', 'action'], ['button', 'formAction']] as const) {
      const html = render(el(tag, { [attr]: v('$p0') }, []), { $p0: 'javascript:alert(1)' })
      expect(html, `${tag} ${attr}`).not.toContain(`${attr === 'formAction' ? 'formaction' : attr}="javascript:alert(1)"`)
    }
  } finally {
    rmSync(file, { force: true })
  }
})

test('holesOf and nestedOf: an island revives what its wrappers\' call sites bind', () => {
  const card = { id: 'card_1', file: '/app/c.tsx', ir: { tier: { React: {} }, export: 'Card' } } as unknown as Compiled
  const badge = { id: 'badge_1', file: '/app/b.tsx', ir: { tier: 'Static', export: 'Badge' } } as unknown as Compiled
  const frame = { id: 'frame_1', file: '/app/f.tsx', ir: { tier: 'Static', children: [{ name: 'Card', id: 'card_1', nested: [], holes: ['$p0', '$c1'] }] } } as unknown as Compiled
  const page = { id: 'page_1', file: '/app/p.tsx', ir: { tier: 'Static', children: [{ name: 'Frame', id: 'frame_1', nested: ['badge_1'] }] } } as unknown as Compiled
  const compiled = new Map([card, badge, frame, page].map((c) => [c.id, c]))
  expect(holesOf(compiled, 'card_1')).toEqual(['$c1', '$p0'])
  expect(holesOf(compiled, 'frame_1')).toEqual([])
  // The wrapper's island is a host (its own ref has `nested`), and it also imports what a call site's tree names.
  expect(nestedOf(compiled, 'card_1')).toEqual(['badge_1'])
  const shim = islandShim(card, compiled)
  expect(shim).toContain('__mk(Comp, props, [], ["$c1","$p0"])')
  expect(shim).toContain('import { Badge as N0 } from "/app/b.tsx"')
  // An island with no `$c` wrapper does not pick up a stranger's nested ids.
  const lone = { id: 'lone_1', file: '/app/l.tsx', ir: { tier: { React: {} }, export: 'Lone' } } as unknown as Compiled
  expect(nestedOf(new Map([...compiled, ['lone_1', lone]]), 'lone_1')).toBeUndefined()
})
