import { createElement } from 'react'
import ArrowPage from './ArrowPage'
import HoistPage from './HoistPage'
import IncludesPage from './IncludesPage'
import ReducerPage from './ReducerPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderArrow = (): string => html(ArrowPage)
export const renderReducer = (): string => html(ReducerPage)
export const renderHoist = (): string => html(HoistPage)
export const renderIncludes = (): string => html(IncludesPage)
