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

let jsxDevInstalled = false
/** F425: Bun picks the dev JSX transform (`jsxDEV` from `react/jsx-dev-runtime`) for modules the process imports directly
 * when NODE_ENV is unset as Bun boots (a plain shell `brust start`), but React's production `react/jsx-dev-runtime` has no
 * `jsxDEV`, and run.ts sets NODE_ENV=production for the workers afterwards. A module that builds a JSX element at import
 * time (`export const el = <b/>`) then died with "jsxDEV_… is not a function". In production, `react/jsx-dev-runtime` is the
 * production `jsx`/`jsxs` (resolved from the app, so it is the app's one React) with a `jsxDEV` over them; dev keeps React's own. */
export function installProductionJsxDev(appDir: string): void {
  if (jsxDevInstalled || process.env.NODE_ENV !== 'production') return
  jsxDevInstalled = true
  Bun.plugin({
    name: 'brust-jsx-dev-production',
    setup(b) {
      b.module('react/jsx-dev-runtime', async () => {
        const rt = await import(Bun.resolveSync('react/jsx-runtime', appDir))
        return {
          exports: { Fragment: rt.Fragment, jsx: rt.jsx, jsxs: rt.jsxs, jsxDEV: (type: unknown, props: unknown, key: unknown, isStatic: boolean) => (isStatic ? rt.jsxs : rt.jsx)(type, props, key) },
          loader: 'object',
        }
      })
    },
  })
}
