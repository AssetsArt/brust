import { createElement } from 'react'
import Page from './Page'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the page. */
export const renderPage = (): string => server.renderToStaticMarkup(createElement(Page))
