import { createElement } from 'react'
import CondPage from './CondPage'
import GatePage from './GatePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the page (the fixture dir is where `react` resolves). */
export const renderCond = (): string => server.renderToStaticMarkup(createElement(CondPage as never))
export const renderGate = (): string => server.renderToStaticMarkup(createElement(GatePage as never))
