// Renders every attribute below with every value through REAL react-dom/server and prints the attributes React wrote
// (name lower-cased, so it compares with the HTML the compiler prints). `tests/fixtures/attr-parity/react.json` is its
// output; `test/attr-parity-react.test.ts` re-runs it and fails when the file is stale, so the Rust matrix
// (`crates/brust-compiler/tests/attr_boolean_parity.rs`) is always compared with what React does today.
// Run from packages/brust: `bun test/attr-parity-gen.ts > ../../tests/fixtures/attr-parity/react.json`
import * as React from 'react'
const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
const renderToString = server.renderToString

export const NAMES = [
  'aria-checked', 'aria-hidden', 'aria-expanded', 'data-x', 'data-state', 'draggable', 'spellCheck', 'contentEditable', 'focusable',
  'autoReverse', 'externalResourcesRequired', 'preserveAlpha', 'value',
  'hidden', 'disabled', 'checked', 'selected', 'multiple', 'muted', 'open', 'inert', 'itemScope', 'allowFullScreen', 'async',
  'autoFocus', 'autoPlay', 'controls', 'default', 'defer', 'formNoValidate', 'loop', 'noModule', 'noValidate', 'playsInline',
  'readOnly', 'required', 'reversed', 'scoped', 'seamless', 'disablePictureInPicture', 'disableRemotePlayback',
  'download', 'capture',
  'translate', 'popover', 'autoCapitalize', 'autoComplete', 'className', 'id', 'tabIndex', 'role', 'title', 'href', 'src',
  'crossOrigin', 'preload', 'wrap', 'is', 'rel', 'inputMode', 'foo',
] as const
export const VALUES = ['true', 'false', '0', '1', "''", 'null', 'undefined', "'x'"] as const
const parse = (v: (typeof VALUES)[number]): unknown => (v === 'undefined' ? undefined : (0, eval)(`(${v})`))

export function render(): Record<string, Record<string, string>> {
  const warn = console.error
  console.error = () => {} // React's dev warnings ("Received `true` for a non-boolean attribute") are the point of some rows
  try {
    return renderAll()
  } finally {
    console.error = warn
  }
}

function renderAll(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const n of NAMES) {
    out[n] = {}
    for (const v of VALUES) {
      // an input for the property booleans (`checked`, `value`), a div for the rest: the attribute table is per name, not per tag
      const tag = n === 'checked' || n === 'value' ? 'input' : n === 'selected' ? 'option' : 'div'
      const html = renderToString(React.createElement(tag, { [n]: parse(v) }))
      const m = /^<\w+([^>]*?)\/?>/.exec(html)!
      out[n][v] = m[1]!.trim().toLowerCase().replace(/\s+/g, ' ')
    }
  }
  return out
}
if (import.meta.main) console.log(JSON.stringify(render(), null, 1))
