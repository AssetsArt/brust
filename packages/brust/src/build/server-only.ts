// The `server-only` marker package (Next.js convention): a module that starts with `import 'server-only'` is server code.
// The published package throws when it is resolved without the `react-server` condition, which both lets server-only code
// into a browser bundle whenever the marker is stubbed (a bundler alias, an empty `node_modules/server-only`) and breaks a
// correct app whose route scan imports it under the default condition. brust does not rely on the throw:
//   - a BROWSER build that reaches the specifier is refused (`server-only-in-client`, bundle.ts `isServerOnly`);
//   - every SERVER side (route scan, worker import of the app, jobs / actions / cache-adapter / build-eval / Worker
//     bundles) resolves it to an empty module, the same thing the `react-server` condition resolves to.
import type { BunPlugin } from 'bun'

const MARKER = /^server-only(\/.*)?$/
const NS = 'brust-server-only-empty'

/** `server-only` itself or one of its subpaths. */
export const isServerOnlyMarker = (spec: string): boolean => MARKER.test(spec)

/** A build plugin for a SERVER bundle: the marker becomes an empty module. */
export function serverOnlyEmptyPlugin(): BunPlugin {
  return {
    name: 'brust-server-only-empty',
    setup(b) {
      b.onResolve({ filter: MARKER }, (a) => ({ path: a.path, namespace: NS }))
      b.onLoad({ filter: /.*/, namespace: NS }, () => ({ contents: 'export {}', loader: 'js' }))
    },
  }
}

let installed = false
/** For code the process imports directly (the build's route scan, the worker's import of the app entry): a virtual
 * module, so a bare `import 'server-only'` never reaches the package. Idempotent; only the marker is touched. */
export function installServerOnlyRuntime(): void {
  if (installed) return
  installed = true
  Bun.plugin({
    name: 'brust-server-only-runtime',
    setup(b) {
      b.module('server-only', () => ({ exports: {}, loader: 'object' }))
    },
  })
}
