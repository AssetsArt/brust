// Bun 1.4 doesn't translate `export *` from a CommonJS module into ES named
// exports — the bundle ends up populating an internal object via __copyProps
// but emits no `export { ... }` statement, so the importmap-targeted browser
// import collapses to a SyntaxError. The CJS source (`node_modules/react-dom/
// client.js`) exposes only `createRoot` and `hydrateRoot`; name them
// explicitly so the bundler has a static export list to emit.
export { createRoot, hydrateRoot } from 'react-dom/client'
// Defensive parity with react.ts: re-expose the namespace as the default so a
// third-party island dep that does `import ReactDOM from 'react-dom/client'`
// resolves a real object (createRoot/hydrateRoot as members) instead of
// failing to hydrate on a missing default export.
import * as ReactDOM from 'react-dom/client'
export default ReactDOM
