import { createElement } from 'react'
import { variant } from './data'
import Page from './Page'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the page for the order variant `o`. */
export const renderPage = (o: string | null): string => server.renderToStaticMarkup(createElement(Page, { box: variant(o) }))
