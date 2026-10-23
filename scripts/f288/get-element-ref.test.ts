// F288 §3 guard (ruling Q1, Detoro 2026-10-23): the compiler folds the installed `@radix-ui/react-presence`
// `getElementRef(element)` over React 19's PRODUCTION element shape to `r || (r ?? null)` (an element with a ref `r`) or
// `null` (none) (crates/brust-compiler/tests/element_value.rs). This runs the package's own function on real elements
// built by `react/jsx-runtime`, in BOTH the production and the development build, and checks it returns what the fold
// says, for a callback ref, an object ref, no ref and a `forwardRef` component child. The fold models React 19 only, so
// the project must resolve React 19.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const store = join(import.meta.dir, '../../node_modules/.bun')
const pkg = (prefix: string) => {
  const d = readdirSync(store).find((n) => n.startsWith(prefix))
  if (!d) throw new Error(`${prefix} is not installed`)
  return join(store, d, 'node_modules')
}
const reactDir = join(pkg('react@'), 'react')
const require = createRequire(join(reactDir, 'package.json'))

/** `getElementRef` exactly as the installed package ships it (dist/index.mjs), evaluated on its own. */
function getElementRef(): (element: unknown) => unknown {
  const dist = readFileSync(join(pkg('@radix-ui+react-presence@'), '@radix-ui/react-presence/dist/index.mjs'), 'utf8')
  const m = /^function getElementRef\(element\) \{[\s\S]*?^\}$/m.exec(dist)
  if (!m) throw new Error('getElementRef not found in the installed @radix-ui/react-presence')
  return new Function(`${m[0]}\nreturn getElementRef`)() as (element: unknown) => unknown
}

/** What the compiler's fold returns for an element whose `ref` prop is `r` (`undefined`: no ref prop). */
const folded = (r: unknown) => (r === undefined ? null : r || (r ?? null))

test('the project resolves React 19 (the fold models its element shape)', () => {
  const v = JSON.parse(readFileSync(join(reactDir, 'package.json'), 'utf8')).version as string
  expect(Number(v.split('.')[0])).toBe(19)
})

for (const build of ['production', 'development'] as const) {
  describe(`react/jsx-runtime ${build}`, () => {
    const { jsx } = require(`./cjs/react-jsx-runtime.${build}.js`) as { jsx: (t: unknown, p: object) => unknown }
    const React = require(`./cjs/react.${build}.js`) as { forwardRef: (f: unknown) => unknown }
    const f = getElementRef()
    const callback = (_: unknown) => {}
    const object = { current: null }
    const Fwd = React.forwardRef((_p: unknown, _r: unknown) => null)
    for (const [what, type, ref] of [
      ['a callback ref', 'div', callback],
      ['an object ref', 'div', object],
      ['no ref', 'div', undefined],
      ['a forwardRef component child with a ref', Fwd, callback],
      ['a forwardRef component child with no ref', Fwd, undefined],
    ] as const) {
      test(what, () => {
        const el = jsx(type, ref === undefined ? { id: 'x' } : { id: 'x', ref })
        expect(f(el)).toBe(folded(ref))
      })
    }
  })
}
