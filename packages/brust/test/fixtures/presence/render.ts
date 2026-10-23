import { createElement } from 'react'
import PresencePage from './PresencePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the page (the fixture dir is where `react` resolves). */
export const renderPresence = (): string => server.renderToStaticMarkup(createElement(PresencePage as never))
