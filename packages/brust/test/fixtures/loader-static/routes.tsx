import { defineRoutes } from '@brust/core/routes'
import { ROWS, SECTIONS } from './data'
import IfRowsPage from './IfRowsPage'
import SwitchRowsPage from './SwitchRowsPage'
import AndRowsPage from './AndRowsPage'
import TernaryRowsPage from './TernaryRowsPage'
import GtRowsPage from './GtRowsPage'
import RootRowsPage from './RootRowsPage'
import ConstPage from './ConstPage'
import ListPage from './ListPage'
import PricesPage from './PricesPage'
import SectionsPage from './SectionsPage'
import StatefulPage from './StatefulPage'

const loader = () => ({ sections: SECTIONS })
const rows = () => ({ rows: ROWS })

export const routes = defineRoutes([
  { path: '/list', Component: ListPage, loader },
  { path: '/prices', Component: PricesPage, loader },
  { path: '/sections', Component: SectionsPage, loader },
  { path: '/stateful', Component: StatefulPage },
  { path: '/const', Component: ConstPage, loader: rows },
  { path: '/rows-if', Component: IfRowsPage, loader: rows },
  { path: '/rows-switch', Component: SwitchRowsPage, loader: rows },
  { path: '/rows-and', Component: AndRowsPage, loader: rows },
  { path: '/rows-ternary', Component: TernaryRowsPage, loader: rows },
  { path: '/rows-gt', Component: GtRowsPage, loader: rows },
  { path: '/rows-root', Component: RootRowsPage, loader: rows },
])
