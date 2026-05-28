import { test, expect } from 'bun:test'

// A2.1 — verify the napi shim `napiRenderCompiled` is callable from Bun and
// returns expected bytes for the committed `static_hello` fixture. End-to-end
// dispatcher integration (rustCompiled route + curl) is exercised by the
// existing `tests/integration.test.ts` set once a route declares it.

// Resolve the .node binary via require() — Bun rejects `import` for native
// modules ("To load Node-API modules, use require() or process.dlopen").
// Path is the workspace cdylib committed by `bun run build`.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const native = require('../runtime/index.darwin-arm64.node') as {
  napiRenderCompiled?: (name: string, dataJson: string) => Buffer
}

const EXPECTED_HTML =
  '<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>'

test('napiRenderCompiled("StaticHello", "{}") returns expected HTML bytes', () => {
  expect(typeof native.napiRenderCompiled).toBe('function')
  const buf = native.napiRenderCompiled!('StaticHello', '{}')
  expect(buf).toBeInstanceOf(Buffer)
  expect(buf.toString('utf8')).toBe(EXPECTED_HTML)
})

test('napiRenderCompiled throws on unknown route name', () => {
  expect(() => native.napiRenderCompiled!('does_not_exist', '{}'))
    .toThrow(/unknown compiled route name/)
})
