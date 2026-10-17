import { createElement } from 'react'
import StylePage from './StylePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the page (the fixture dir is where `react` resolves). */
export const renderStyle = (): string => server.renderToStaticMarkup(createElement(StylePage as never))
