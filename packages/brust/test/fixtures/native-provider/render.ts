import { createElement } from 'react'
import CtxVPage from './CtxVPage'
import DirNonePage from './DirNonePage'
import DirProvPage from './DirProvPage'
import CollPage from './CollPage'
import FwdPage from './FwdPage'
import GatePage from './GatePage'
import HydrPage from './HydrPage'
import HooksPage from './HooksPage'
import Nested from './Nested'
import NestedIds from './NestedIds'
import InputsPage from './InputsPage'
import LoopPage from './LoopPage'
import Page from './Page'
import RestPage from './RestPage'
import LocalSpreadPage from './LocalSpreadPage'
import LocalSpreadRestPage from './LocalSpreadRestPage'
import SwPage from './SwPage'
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
export const renderHooks = (): string => html(HooksPage)
export const renderDir = (): string => html(DirNonePage)
export const renderDirProvider = (): string => html(DirProvPage)
export const renderHydr = (): string => html(HydrPage)
export const renderColl = (): string => html(CollPage)
export const renderCtxV = (): string => html(CtxVPage)
export const renderLocalSpread = (): string => html(LocalSpreadPage)
export const renderLocalSpreadRest = (): string => html(LocalSpreadRestPage)
export const renderSw = (kind: string): string => server.renderToStaticMarkup(createElement(SwPage as never, { kind } as never))
