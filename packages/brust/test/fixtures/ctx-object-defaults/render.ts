import { createElement } from 'react'
import DestructurePage from './DestructurePage'
import FieldPage from './FieldPage'
import InlinePage from './InlinePage'
import NestedPage from './NestedPage'
import OverridePage from './OverridePage'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }
const pages: Record<string, unknown> = { '/field': FieldPage, '/destructure': DestructurePage, '/override': OverridePage, '/nested': NestedPage, '/inline': InlinePage }

/** React's own render of the page at `path` (the fixture dir is where `react` resolves). */
export const renderReact = (path: string): string => server.renderToStaticMarkup(createElement(pages[path] as never))
