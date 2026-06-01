import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/** Fragment lowering — integration assertion via compileJsx (napi addon).
 *
 * Strategy: call compileJsx directly (no server spawn, no port race) on a
 * source containing a root fragment inside a div and assert that the compiled
 * template has no wrapper element injected around the fragment children.
 *
 * This is the lightest integration path: it drives the real production addon
 * (not the cargo-test harness) and proves the fragment → jinja pipeline
 * end-to-end without the heavyweight route-spawn infrastructure.
 */

const REPO_ROOT = resolve(import.meta.dir, '..')

// Import the real napi addon (same path native-routes-emit.ts uses).
const native = await import(resolve(REPO_ROOT, 'runtime/index.js'))
const compileJsx = (
  native as { compileJsx: (source: string, path: string) => { template: string } }
).compileJsx

const FRAGMENT_SOURCE = readFileSync(
  resolve(REPO_ROOT, 'crates/jsx-rust-compiler/fixtures/fragment_basic.tsx'),
  'utf8',
)

test('fragment children rendered without wrapper element', () => {
  const result = compileJsx(FRAGMENT_SOURCE, 'fragment_basic.tsx')
  const template = result.template

  // Must contain both children directly inside the div.
  expect(template).toContain('<h1>One</h1>')
  expect(template).toContain('<p>Two</p>')

  // Must NOT inject a wrapper element around the fragment children.
  // The only outer element should be the explicit <div>.
  // Reject any element wrapping the two children (e.g. <span>, <div> injected
  // by a naive fragment impl, etc.).  The canonical emit is:
  //   <div><h1>One</h1><p>Two</p></div>
  expect(template).toBe('<div><h1>One</h1><p>Two</p></div>')
})
