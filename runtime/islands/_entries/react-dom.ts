// Bun 1.4 doesn't translate `export *` from a CommonJS module into ES named
// exports — the bundle ends up populating an internal object via __copyProps
// but emits no `export { ... }` statement, so the importmap-targeted browser
// import collapses to a SyntaxError. The CJS source (`node_modules/react-dom/
// client.js`) exposes only `createRoot` and `hydrateRoot`; name them
// explicitly so the bundler has a static export list to emit.
export { createRoot, hydrateRoot } from 'react-dom/client'
