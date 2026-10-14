// L33: the feature set of a component comes from its compiled output; an unknown directive or an unshipped module is a build error.
import { expect, test } from 'bun:test'
import { directiveAttrs, featureOfAttr, featuresOf, RUNTIME_FEATURES, withoutJinja } from '../src/build/features'

test('every directive maps to one module, in load order', () => {
  const tpl = '<div x-data="a" x-props=\'{"a":1}\'><b x-text="t" x-show="s" x-bind-class="c" x-on-click="go" x-ref="r"></b><i x-if="c" x-for="a in b"></i><input x-model="m"><p x-html="h"></p></div>'
  expect(featuresOf('c', tpl, false)).toEqual(['basics', 'if', 'for', 'model', 'html'])
  expect(featuresOf('c', '<div x-data="a" x-props-bind="m"><p x-raw></p></div>', false)).toEqual([])
  expect(featuresOf('c', '<brust-island data-id="x"></brust-island>', true)).toEqual(['island'])
  expect([...RUNTIME_FEATURES]).toEqual(['basics', 'if', 'for', 'model', 'html', 'island'])
})

test('prose that spells a directive binds nothing; only attributes on tags count', () => {
  const tpl = '<p>write x-for="a in b" or x-model on an input</p><code>&lt;p x-if="c"&gt;</code><p x-text="t">x-show</p>'
  expect([...directiveAttrs(tpl)]).toEqual(['x-text'])
  expect(featuresOf('c', tpl, false)).toEqual(['basics'])
})

test('a directive no module binds is a build error, never a silent no-op', () => {
  expect(featureOfAttr('x-portal')).toBeUndefined()
  expect(() => featuresOf('card_1', '<div x-portal="p"></div>', false)).toThrow(expect.objectContaining({ rule: 'runtime-feature-missing', message: expect.stringContaining('card_1: the template uses x-portal') }))
})

test('a printed value with > or quotes inside a jinja tag never hides the directives after it (F149)', () => {
  // shadcn's Button class, folded at build into the template (a jinja string literal on the tag).
  const cls = `"inline-flex [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-3"`
  const tpl = `<button{% if ${cls} | present %} class="{{ ${cls} | attr_str | e }}"{% endif %} x-on-click="_h1">Go</button>`
  expect([...directiveAttrs(tpl)]).toEqual(['x-on-click'])
  expect(featuresOf('c', tpl, false)).toEqual(['basics'])
  // A directive spelled inside a printed value is data, not an attribute.
  expect([...directiveAttrs('<p class="{{ "x-on-click=\\"go\\"" | e }}">x</p>')]).toEqual([])
  expect(withoutJinja('a{{ "}}" }}b{% if x %}c{% endif %}{# x-show #}d{x}')).toBe('a b c  d{x}')
})
