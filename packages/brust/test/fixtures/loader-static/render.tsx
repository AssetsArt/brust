// The React reference: the same pages rendered by react-dom/server with the loader's data.
import { renderToStaticMarkup } from 'react-dom/server'
import { SECTIONS } from './data'
import ListPage from './ListPage'
import PricesPage from './PricesPage'
import SectionsPage from './SectionsPage'

export function reactHtml(page: 'list' | 'prices' | 'sections'): string {
  const C = { list: ListPage, prices: PricesPage, sections: SectionsPage }[page]
  return renderToStaticMarkup(<C sections={SECTIONS} />)
}
