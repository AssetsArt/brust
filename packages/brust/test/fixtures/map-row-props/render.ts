import { createElement } from 'react'
import { pages } from './pages'

const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

/** React's own render of a page (the fixture dir is where `react` resolves). */
export const renderPage = (p: string): string => server.renderToString(createElement(pages[p] as never))
