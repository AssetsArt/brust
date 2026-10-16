import { createElement } from 'react'
import GatePage from './GatePage'
import Nested from './Nested'
import NestedIds from './NestedIds'
import InputsPage from './InputsPage'
import Page from './Page'
import RenderPage from './RenderPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderPage = (): string => html(Page)
export const renderNested = (): string => html(Nested)
export const renderNestedIds = (): string => html(NestedIds)
export const renderGate = (): string => html(GatePage)
export const renderRender = (): string => html(RenderPage)
export const renderInputs = (): string => html(InputsPage)
