import { createElement } from 'react'
import { pages } from './pages'
const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
export const renderPage = (p: string): string => server.renderToString(createElement(pages[p] as never))
