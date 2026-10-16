import { createElement } from 'react'
import FwdPage from './FwdPage'
import GatePage from './GatePage'
import Nested from './Nested'
import NestedIds from './NestedIds'
import InputsPage from './InputsPage'
import LoopPage from './LoopPage'
import Page from './Page'
import RestPage from './RestPage'
import SamePage from './SamePage'
import RenderPage from './RenderPage'
import PolyPage from './PolyPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderPage = (): string => html(Page)
export const renderNested = (): string => html(Nested)
export const renderNestedIds = (): string => html(NestedIds)
export const renderGate = (): string => html(GatePage)
export const renderRender = (): string => html(RenderPage)
export const renderInputs = (): string => html(InputsPage)
export const renderPoly = (): string => html(PolyPage)
export const renderFwd = (): string => html(FwdPage)
export const renderSame = (): string => html(SamePage)
export const renderRest = (): string => html(RestPage)
export const renderLoop = (loop: string): string => server.renderToStaticMarkup(createElement(LoopPage as never, { loop } as never))
