import { defineRoutes } from '@brust/core/routes'
import { SECTIONS } from './data'
import ListPage from './ListPage'
import PricesPage from './PricesPage'
import SectionsPage from './SectionsPage'
import StatefulPage from './StatefulPage'

const loader = () => ({ sections: SECTIONS })

export const routes = defineRoutes([
  { path: '/list', Component: ListPage, loader },
  { path: '/prices', Component: PricesPage, loader },
  { path: '/sections', Component: SectionsPage, loader },
  { path: '/stateful', Component: StatefulPage },
])
