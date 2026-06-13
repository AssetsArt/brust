// Combined re-export. The browser's importmap maps BOTH `react` and
// `react/jsx-runtime` to the chunk built from this file. Browser fetches
// once; different import statements slice different named exports from
// the same module.
//
// `export *` from `react` includes Fragment; `react/jsx-runtime` also
// exports Fragment. We re-export only jsx + jsxs from jsx-runtime to
// avoid the name collision (Fragment from react wins, which is the
// same object).
export * from 'react'
export { jsx, jsxs } from 'react/jsx-runtime'
// `export *` omits the default per spec, so the importmap-targeted `react`
// chunk had named exports but NO default — third-party ESM that does
// `import React from 'react'` (e.g. @dnd-kit) then fails to hydrate with
// "module 'react' does not provide an export named 'default'". Re-expose the
// React namespace as the default: it carries createElement/useState/etc. as
// members, matching what a normal `import React from 'react'` yields.
import * as React from 'react'
export default React
