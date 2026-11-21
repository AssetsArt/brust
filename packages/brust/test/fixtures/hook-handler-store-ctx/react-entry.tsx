import { createElement } from 'react'
// @ts-expect-error react-dom ships no type declarations in this workspace
import { hydrateRoot } from 'react-dom/client'
import * as C from './CtxPages'

// The React reference in the browser: the context page named by `window.__page`, hydrated by React itself.
const w = window as unknown as { __page: keyof typeof C; __props: Record<string, unknown>; __hydrated: boolean }
hydrateRoot(document.getElementById('root')!, createElement(C[w.__page] as never, w.__props as never))
w.__hydrated = true
