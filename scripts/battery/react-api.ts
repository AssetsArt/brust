// The React reference, entry by entry: what the coverage page is organised by (docs/react-coverage.json).
// Enumerated from https://react.dev/reference/react (the sidebar plus the Hooks / Components / APIs index pages) and
// https://react.dev/reference/react-dom (components, hooks, APIs) on FETCHED below; never typed from memory. A test
// (`bun test scripts/battery/react-api.test.ts`) fails when an entry has no battery row (`api: [name]`) or a row names an
// entry that is not here. To refresh: re-fetch both reference trees, diff against this list, add the new entries here
// and give each at least one row in rows.ts.
//
// OUT OF SCOPE (R18.1): legacy APIs (react.dev/reference/react/legacy: Children, cloneElement, Component, createElement,
// createRef, forwardRef, isValidElement, PureComponent), react-dom/client and /server entry points
// (createRoot, hydrateRoot, renderToString, prerender, ...), the React Compiler / eslint-plugin / rules pages.
// Rows for some of those still exist (they are authoring patterns), but they are not coverage claims about the reference.

/** Date the reference was fetched (YYYY-MM-DD). */
export const FETCHED = '2026-10-13'

export type ApiGroup = 'hooks' | 'components' | 'apis' | 'react-dom-hooks' | 'react-dom-components' | 'react-dom-apis' | 'server'

export const API_GROUPS: Record<ApiGroup, string> = {
  hooks: 'Hooks',
  components: 'Components',
  apis: 'APIs',
  'react-dom-hooks': 'react-dom hooks',
  'react-dom-components': 'react-dom components',
  'react-dom-apis': 'react-dom APIs',
  server: 'Server',
}

export interface ApiEntry {
  /** As react.dev spells it (`useState`, `<Suspense>`, `'use client'`). Unique. */
  name: string
  group: ApiGroup
  url: string
}

const R = 'https://react.dev/reference/react'
const D = 'https://react.dev/reference/react-dom'
const e = (group: ApiGroup, name: string, url: string): ApiEntry => ({ name, group, url })

export const REACT_API: ApiEntry[] = [
  // ---- Hooks (react.dev/reference/react/hooks) ----
  e('hooks', 'useActionState', `${R}/useActionState`),
  e('hooks', 'useCallback', `${R}/useCallback`),
  e('hooks', 'useContext', `${R}/useContext`),
  e('hooks', 'useDebugValue', `${R}/useDebugValue`),
  e('hooks', 'useDeferredValue', `${R}/useDeferredValue`),
  e('hooks', 'useEffect', `${R}/useEffect`),
  e('hooks', 'useEffectEvent', `${R}/useEffectEvent`),
  e('hooks', 'useId', `${R}/useId`),
  e('hooks', 'useImperativeHandle', `${R}/useImperativeHandle`),
  e('hooks', 'useInsertionEffect', `${R}/useInsertionEffect`),
  e('hooks', 'useLayoutEffect', `${R}/useLayoutEffect`),
  e('hooks', 'useMemo', `${R}/useMemo`),
  e('hooks', 'useOptimistic', `${R}/useOptimistic`),
  e('hooks', 'useReducer', `${R}/useReducer`),
  e('hooks', 'useRef', `${R}/useRef`),
  e('hooks', 'useState', `${R}/useState`),
  e('hooks', 'useSyncExternalStore', `${R}/useSyncExternalStore`),
  e('hooks', 'useTransition', `${R}/useTransition`),
  // ---- Components (react.dev/reference/react/components) ----
  e('components', '<Activity>', `${R}/Activity`),
  e('components', '<Fragment>', `${R}/Fragment`),
  e('components', '<Profiler>', `${R}/Profiler`),
  e('components', '<StrictMode>', `${R}/StrictMode`),
  e('components', '<Suspense>', `${R}/Suspense`),
  e('components', '<ViewTransition>', `${R}/ViewTransition`),
  // ---- APIs (react.dev/reference/react/apis) ----
  e('apis', 'act', `${R}/act`),
  e('apis', 'addTransitionType', `${R}/addTransitionType`),
  e('apis', 'cache', `${R}/cache`),
  e('apis', 'cacheSignal', `${R}/cacheSignal`),
  e('apis', 'captureOwnerStack', `${R}/captureOwnerStack`),
  e('apis', 'createContext', `${R}/createContext`),
  e('apis', 'experimental_taintObjectReference', `${R}/experimental_taintObjectReference`),
  e('apis', 'experimental_taintUniqueValue', `${R}/experimental_taintUniqueValue`),
  e('apis', 'lazy', `${R}/lazy`),
  e('apis', 'memo', `${R}/memo`),
  e('apis', 'startTransition', `${R}/startTransition`),
  e('apis', 'use', `${R}/use`),
  // ---- react-dom hooks ----
  e('react-dom-hooks', 'useFormStatus', `${D}/hooks/useFormStatus`),
  // ---- react-dom components that matter for brust ----
  e('react-dom-components', '<form>', `${D}/components/form`),
  e('react-dom-components', '<input>', `${D}/components/input`),
  e('react-dom-components', '<select>', `${D}/components/select`),
  e('react-dom-components', '<textarea>', `${D}/components/textarea`),
  e('react-dom-components', '<title>', `${D}/components/title`),
  e('react-dom-components', '<meta>', `${D}/components/meta`),
  e('react-dom-components', '<link>', `${D}/components/link`),
  e('react-dom-components', '<style>', `${D}/components/style`),
  e('react-dom-components', '<script>', `${D}/components/script`),
  // ---- react-dom APIs that matter for brust ----
  e('react-dom-apis', 'createPortal', `${D}/createPortal`),
  e('react-dom-apis', 'flushSync', `${D}/flushSync`),
  e('react-dom-apis', 'preconnect', `${D}/preconnect`),
  e('react-dom-apis', 'prefetchDNS', `${D}/prefetchDNS`),
  e('react-dom-apis', 'preinit', `${D}/preinit`),
  e('react-dom-apis', 'preinitModule', `${D}/preinitModule`),
  e('react-dom-apis', 'preload', `${D}/preload`),
  e('react-dom-apis', 'preloadModule', `${D}/preloadModule`),
  // ---- Server (react.dev/reference/rsc) ----
  e('server', "'use client'", 'https://react.dev/reference/rsc/use-client'),
  e('server', "'use server'", 'https://react.dev/reference/rsc/use-server'),
  e('server', 'Server Components', 'https://react.dev/reference/rsc/server-components'),
  e('server', 'Server Functions', 'https://react.dev/reference/rsc/server-functions'),
]
