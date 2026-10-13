import { defineRoutes } from '@brust/core/routes'
import Page from './Page'
import Rows from './Rows'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  {
    path: '/rows',
    Component: Rows,
    loader: async () => ({
      items: [
        { id: 'a', name: 'alpha' },
        { id: 'b', name: 'beta' },
      ],
    }),
  },
])
