import { createElement } from 'react'
// @ts-expect-error react-dom ships no type declarations in this workspace
import { hydrateRoot } from 'react-dom/client'
import Page from './Page'

// The React reference in the browser: the same page, hydrated by React itself.
hydrateRoot(document.getElementById('root')!, createElement(Page))
;(window as unknown as { __hydrated: boolean }).__hydrated = true
