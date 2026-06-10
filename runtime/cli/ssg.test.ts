import { test, expect } from 'bun:test'
import { collectStaticPaths, type FlatRouteLike } from './ssg.ts'

function route(fullPath: string, chain: FlatRouteLike['chain'] = [{}]): FlatRouteLike {
  return { fullPath, chain }
}

test('root path maps to index.html and is included', () => {
  const [d] = collectStaticPaths([route('/')])
  expect(d.include).toBe(true)
  expect(d.reason).toBeUndefined()
  expect(d.outFile).toBe('index.html')
})

test('nested path maps to <path>/index.html', () => {
  const [d] = collectStaticPaths([route('/docs/intro')])
  expect(d.include).toBe(true)
  expect(d.outFile).toBe('docs/intro/index.html')
})

test('trailing slash maps to the same outFile', () => {
  const [d] = collectStaticPaths([route('/docs/intro/')])
  expect(d.outFile).toBe('docs/intro/index.html')
})

test('trailing-slash duplicates dedupe to one decision', () => {
  const out = collectStaticPaths([route('/docs/intro'), route('/docs/intro/')])
  expect(out.length).toBe(1)
  expect(out[0].outFile).toBe('docs/intro/index.html')
})

test('dynamic {param} segment → excluded with reason dynamic-param', () => {
  const [d] = collectStaticPaths([route('/pokemon/{name}')])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('dynamic-param')
})

test('wildcard segment → excluded with reason wildcard', () => {
  const [d] = collectStaticPaths([route('/files/*')])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('wildcard')
})

test('leaf sse route → excluded with reason sse', () => {
  const [d] = collectStaticPaths([route('/events', [{}, { sse: () => {} }])])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('sse')
})

test('leaf websocket route → excluded with reason websocket', () => {
  const [d] = collectStaticPaths([route('/ws', [{}, { websocket: () => {} }])])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('websocket')
})

test('sse/websocket are checked on the LEAF chain node only', () => {
  // A parent node with sse can't exist in practice (sse routes have no
  // children), but the contract is leaf-only — a non-sse leaf stays included.
  const [d] = collectStaticPaths([route('/docs', [{ sse: () => {} }, {}])])
  expect(d.include).toBe(true)
  expect(d.reason).toBeUndefined()
})

test('output is deterministic — sorted by fullPath regardless of input order', () => {
  const out = collectStaticPaths([route('/z'), route('/'), route('/docs/intro'), route('/a')])
  expect(out.map((d) => d.fullPath)).toEqual(['/', '/a', '/docs/intro', '/z'])
})

test('excluded routes still carry an outFile mapping', () => {
  const [d] = collectStaticPaths([route('/blog/{slug}')])
  expect(d.outFile).toBe('blog/{slug}/index.html')
})
