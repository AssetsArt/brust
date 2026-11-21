import { createElement } from 'react'
import { installServerResolver } from '../../../src/store/core-adapter'
import { getServerInstance, runInStoreContext } from '../../../src/store/server-context'
import { PAGES } from './pages'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

// React renders with the stores of one request, as a server worker does (a fresh `hhStore` per render).
installServerResolver(getServerInstance)

/** React's own render of a page (the fixture dir is where `react` resolves). */
export const render = (path: keyof typeof PAGES, props: Record<string, unknown> = {}): string =>
  runInStoreContext(() => server.renderToStaticMarkup(createElement(PAGES[path] as never, props as never)))
