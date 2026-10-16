import { createElement } from 'react'
import DestructuredPage from './DestructuredPage'
import MemoPage from './MemoPage'
import WholePage from './WholePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderWhole = (): string => html(WholePage)
export const renderDestructured = (): string => html(DestructuredPage)
export const renderMemo = (): string => html(MemoPage)
