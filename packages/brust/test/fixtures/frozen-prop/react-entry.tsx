import { createElement } from 'react'
// @ts-expect-error react-dom ships no type declarations in this workspace
import { hydrateRoot } from 'react-dom/client'
import { pages } from './pages'

// The React reference in the browser: the same page, hydrated by React itself.
const w = window as unknown as { __page: string; __hydrated: boolean }
hydrateRoot(document.getElementById('root')!, createElement(pages[w.__page] as never))
w.__hydrated = true
