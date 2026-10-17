import { createElement } from 'react'
import ImportedPage from './ImportedPage'
import LocalPage from './LocalPage'
import SeedPage from './SeedPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderLocal = (): string => html(LocalPage)
export const renderImported = (): string => html(ImportedPage)
export const renderSeed = (): string => html(SeedPage)
