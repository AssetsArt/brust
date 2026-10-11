import { defineRoutes } from '@brust/core/routes'
import AppLayout from './AppLayout'
import BothPage from './BothPage'
import CartPage from './CartPage'
import HomePage from './HomePage'
import IslandPage from './IslandPage'
import { bothLoader, cartLoader, islandLoader, plainLoader } from './loaders'
import PlainPage from './PlainPage'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage },
      { path: '/cart', Component: CartPage, loader: cartLoader, cache: { ttl_seconds: 60 } },
      { path: '/plain', Component: PlainPage, loader: plainLoader },
      { path: '/both', Component: BothPage, loader: bothLoader },
      { path: '/island', Component: IslandPage, loader: islandLoader, cache: { ttl_seconds: 60 } },
    ],
  },
])
