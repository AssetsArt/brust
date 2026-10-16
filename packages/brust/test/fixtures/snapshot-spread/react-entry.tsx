import { createElement } from 'react'
// @ts-expect-error react-dom ships no type declarations in this workspace
import { hydrateRoot } from 'react-dom/client'
import Guarded from './Guarded'
import Page from './Page'

// The React reference in the browser: the same page, hydrated by React itself.
const w = window as unknown as { __page: string; __hydrated: boolean }
hydrateRoot(document.getElementById('root')!, createElement(w.__page === 'guarded' ? Guarded : Page))
w.__hydrated = true
