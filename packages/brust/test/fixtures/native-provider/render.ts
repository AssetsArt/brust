import { createElement } from 'react'
import Nested from './Nested'
import NestedIds from './NestedIds'
import Page from './Page'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderPage = (): string => html(Page)
export const renderNested = (): string => html(Nested)
export const renderNestedIds = (): string => html(NestedIds)
