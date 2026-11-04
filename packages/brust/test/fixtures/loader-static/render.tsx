// The React reference: the same pages rendered by react-dom/server with the loader's data.
import { renderToStaticMarkup } from 'react-dom/server'
import { ROWS, SECTIONS } from './data'
import IfRowsPage from './IfRowsPage'
import SwitchRowsPage from './SwitchRowsPage'
import AndRowsPage from './AndRowsPage'
import TernaryRowsPage from './TernaryRowsPage'
import GtRowsPage from './GtRowsPage'
import RootRowsPage from './RootRowsPage'
import ListPage from './ListPage'
import PricesPage from './PricesPage'
import SectionsPage from './SectionsPage'

export function reactHtml(page: 'list' | 'prices' | 'sections'): string {
  const C = { list: ListPage, prices: PricesPage, sections: SectionsPage }[page]
  return renderToStaticMarkup(<C sections={SECTIONS} />)
}

export type RowsPage = 'if' | 'switch' | 'and' | 'ternary' | 'gt' | 'root'

export function reactRowsHtml(page: RowsPage): string {
  const C = { if: IfRowsPage, switch: SwitchRowsPage, and: AndRowsPage, ternary: TernaryRowsPage, gt: GtRowsPage, root: RootRowsPage }[page]
  return renderToStaticMarkup(<C rows={ROWS} />)
}
