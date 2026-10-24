import { createElement } from 'react'
import PresencePage from './PresencePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the page (the fixture dir is where `react` resolves). */
export const renderPresence = (): string => server.renderToStaticMarkup(createElement(PresencePage as never))

/** React's render of the element-child page (phase B), to be hydrated by React in the browser. */
export const renderElement = async (): Promise<string> => {
  const { default: ElementPage } = await import('./ElementPage')
  return (server as unknown as { renderToString(el: unknown): string }).renderToString(createElement(ElementPage as never))
}

/** React's render of the `$cr`-spelled refs page (phase B review F1). */
export const renderCrumb = async (): Promise<string> => {
  const { default: CrumbPage } = await import('./CrumbPage')
  return (server as unknown as { renderToString(el: unknown): string }).renderToString(createElement(CrumbPage as never))
}
