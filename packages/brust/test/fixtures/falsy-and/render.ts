import { createElement } from 'react'
import FlipPage from './FlipPage'
import StaticPage from './StaticPage'
import ZeroPage from './ZeroPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderFlip = (): string => html(FlipPage)
export const renderZero = (): string => html(ZeroPage)
export const renderStatic = (): string => html(StaticPage)
