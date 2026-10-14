import { createElement } from 'react'
import Stepper from './Stepper'

const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

/** React's own render of the component (the fixture dir is where `react` resolves). */
export const renderStepper = (): string => server.renderToString(createElement(Stepper))
