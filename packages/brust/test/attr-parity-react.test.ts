// The committed React output the Rust matrix compares with must be what react-dom does today (F196).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
const renderToString = server.renderToString
import { render } from './attr-parity-gen'

test('tests/fixtures/attr-parity/react.json is what react-dom/server prints now', () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, '../../../tests/fixtures/attr-parity/react.json'), 'utf8'))
  expect(render()).toEqual(file)
})

test('React omits an empty src/href except on an anchor (the compiler rule in lower/template.rs `empty_url_dropped`)', () => {
  const warn = console.error
  console.error = () => {}
  try {
    const html = (tag: string, name: string) => renderToString(createElement(tag, { [name]: '' }))
    expect(html('img', 'src')).toBe('<img/>')
    expect(html('iframe', 'src')).toBe('<iframe></iframe>')
    expect(html('link', 'href')).toBe('<link/>')
    expect(html('a', 'href')).toBe('<a href=""></a>')
  } finally {
    console.error = warn
  }
})

test('tests/fixtures/attr-parity/react-custom.json is what react-dom/server prints for a custom element now (F213)', () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, '../../../tests/fixtures/attr-parity/react-custom.json'), 'utf8'))
  expect(render(true)).toEqual(file)
  // the rule: every attribute passes through; true is "", false/null/undefined omit, anything else is its string
  expect(file.loop.true).toBe('loop=""')
  expect(file['aria-hidden'].false).toBe('')
  expect(file.foo['0']).toBe('foo="0"')
})
