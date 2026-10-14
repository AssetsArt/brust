import { createElement } from 'react'
import Gizmo from './Gizmo'

const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

/** React's own render of the component for a starting state (the fixture dir is where `react` resolves). */
export const renderGizmo = (start: boolean): string => server.renderToString(createElement(Gizmo, { start }))
