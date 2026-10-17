import { createElement } from 'react'
// @ts-expect-error no react-dom types here
import { hydrateRoot } from 'react-dom/client'
import { pages } from './pages'
const w = window as unknown as { __page: string; __hydrated: boolean }
hydrateRoot(document.getElementById('root')!, createElement(pages[w.__page] as never))
w.__hydrated = true
