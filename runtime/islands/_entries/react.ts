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
