import { createElement } from 'react'
import AttrPage from './AttrPage'
import IdPage from './IdPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderAttr = (): string => html(AttrPage)
export const renderId = (): string => html(IdPage)
