import { createElement } from 'react'
import Guarded from './Guarded'
import Page from './Page'

const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

/** React's own render of a page (the fixture dir is where `react` resolves). */
export const renderPage = (which: 'page' | 'guarded' = 'page'): string => server.renderToString(createElement(which === 'page' ? Page : Guarded))
