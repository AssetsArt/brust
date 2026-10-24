import { createElement } from 'react'
import SelectPage from './SelectPage'
import TextareaPage from './TextareaPage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the pages (the fixture dir is where `react` resolves). */
const html = (c: unknown): string => server.renderToStaticMarkup(createElement(c as never))
export const renderSelect = (): string => html(SelectPage)
export const renderTextarea = (): string => html(TextareaPage)
