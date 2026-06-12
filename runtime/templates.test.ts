// Exercises the R1 dynamic template registry API against the REAL Rust NAPI
// addon (no mock.module — a module mock of ./index.js leaks across the whole
// test worker and breaks unrelated tests that import the native barrel, since
// Bun's mock.restore() does not undo mock.module). Requires the built addon
// (`bun run build:debug`).
//
// Names use a `tstest/` prefix unique to this suite — the Rust registry is
// process-global, so collisions with other suites would otherwise be possible.
import { afterAll, expect, test } from 'bun:test'
import { templates } from './templates.ts'

const NAME = 'tstest/shop/1/section/2@v1'
const NAME2 = 'tstest/shop/1/section/3@v1'
const NAME_STATIC = 'tstest/static-hr'
const NAME_REMOVE = 'tstest/removable'

afterAll(() => {
  for (const name of [NAME, NAME2, NAME_STATIC, NAME_REMOVE]) {
    templates.remove(name)
  }
})

test('register + render with data, has, list', () => {
  templates.register(NAME, '<div class="s">{{ title }}</div>')
  expect(templates.render(NAME, { title: 'X' })).toBe('<div class="s">X</div>')
  expect(templates.has(NAME)).toBe(true)
  expect(templates.list()).toContain(NAME)
})

test('re-register replaces the template body', () => {
  templates.register(NAME, '<p>{{ title }}</p>')
  expect(templates.render(NAME, { title: 'X' })).toBe('<p>X</p>')
})

// Bun's expect(fn).toThrow() ALSO passes when fn merely RETURNS an Error
// (verified empirically) — and the napi-rs v3 sync bindings return Errors
// under Bun rather than throwing. So a real throw must be pinned manually.
function mustThrow(fn: () => unknown): Error {
  let caught: unknown
  let returned: unknown
  let threw = false
  try {
    returned = fn()
  } catch (e) {
    caught = e
    threw = true
  }
  if (!threw) {
    throw new Error(`expected a throw, got return value: ${String(returned)}`)
  }
  expect(caught).toBeInstanceOf(Error)
  return caught as Error
}

test('syntax error throws and leaves the previous registration intact', () => {
  templates.register(NAME2, '<span>{{ title }}</span>')
  const err = mustThrow(() => templates.register(NAME2, '{% for x in %}'))
  expect(err.message).toContain('syntax')
  // The failed register must not clobber the good body.
  expect(templates.render(NAME2, { title: 'Y' })).toBe('<span>Y</span>')
})

test('remove returns true then false; has/render reflect removal', () => {
  templates.register(NAME_REMOVE, '<b>gone soon</b>')
  expect(templates.remove(NAME_REMOVE)).toBe(true)
  expect(templates.remove(NAME_REMOVE)).toBe(false)
  expect(templates.has(NAME_REMOVE)).toBe(false)
  mustThrow(() => templates.render(NAME_REMOVE))
})

test('render of an unknown template throws (a real throw, not a returned Error)', () => {
  mustThrow(() => templates.render('no-such-template-xyz-12345'))
})

test('render with no data arg works for a static template', () => {
  templates.register(NAME_STATIC, '<hr>')
  expect(templates.render(NAME_STATIC)).toBe('<hr>')
})
