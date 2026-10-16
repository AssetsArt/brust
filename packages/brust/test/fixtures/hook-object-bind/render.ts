import { createElement } from 'react'
import CompDestructPage from './CompDestructPage'
import CompPage from './CompPage'
import DestructuredPage from './DestructuredPage'
import OwnComputedPage from './OwnComputedPage'
import OwnPage from './OwnPage'
import MemoPage from './MemoPage'
import WholePage from './WholePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderWhole = (): string => html(WholePage)
export const renderDestructured = (): string => html(DestructuredPage)
export const renderMemo = (): string => html(MemoPage)
export const renderComp = (): string => html(CompPage)
export const renderCompDestruct = (): string => html(CompDestructPage)
export const renderOwn = (): string => html(OwnPage)
export const renderOwnComputed = (): string => html(OwnComputedPage)
