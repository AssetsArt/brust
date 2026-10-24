import { createElement } from 'react'
import Page from './Page'

const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

/** React's own render of the page (the fixture dir is where `react` resolves). */
export const renderPage = (): string => server.renderToString(createElement(Page as never))
