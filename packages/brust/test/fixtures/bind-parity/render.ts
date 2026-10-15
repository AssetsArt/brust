import { createElement } from 'react'
import Probe from './Probe'

const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

/** React's own render of the component for a starting state (the fixture dir is where `react` resolves). */
export const renderProbe = (start: boolean): string => server.renderToString(createElement(Probe, { start }))
