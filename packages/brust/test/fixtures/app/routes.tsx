import { defineRoutes } from '@brust/brust/routes'
import AppLayout from './AppLayout'
import HomePage from './HomePage'
import ItemPage from './ItemPage'
import { itemLoader } from './loaders'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage },
      { path: '/items/{id}', Component: ItemPage, loader: itemLoader, cache: { ttl_seconds: 60, tags: ['items'] } },
    ],
  },
])
