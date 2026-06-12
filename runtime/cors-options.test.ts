import { test, expect } from 'bun:test'
import { validateCorsOptions } from './index.ts'

// Boot validation only — no server is started. The same rules are re-checked
// Rust-side in begin_serve (crates/brust-core config::CorsConfig::validate);
// the full request-level behavior lives in tests/cors.integration.test.ts.

test('credentials + wildcard origin throws at boot', () => {
  expect(() => validateCorsOptions({ origins: ['*'], credentials: true })).toThrow(/wildcard/)
  // A list CONTAINING '*' is wildcard — mixing in exact origins can't dodge it.
  expect(() =>
    validateCorsOptions({ origins: ['https://a.example', '*'], credentials: true }),
  ).toThrow(/wildcard/)
})

test('empty origins throws', () => {
  expect(() => validateCorsOptions({ origins: [] })).toThrow(/non-empty/)
})

test('valid configs pass', () => {
  expect(() => validateCorsOptions({ origins: ['*'] })).not.toThrow()
  expect(() =>
    validateCorsOptions({
      origins: ['https://a.example'],
      credentials: true,
      exposeHeaders: ['x-render-ms'],
      maxAgeSeconds: 600,
    }),
  ).not.toThrow()
})
