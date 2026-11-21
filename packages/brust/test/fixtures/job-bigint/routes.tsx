import { defineRoutes } from '@brust/core/routes'
import LoaderPage from './LoaderPage'
import Page from './Page'

export const routes = defineRoutes([
  { path: '/p/{k}', Component: Page, loader: ({ params }: any) => ({ x: params.k }) },
  { path: '/l', Component: LoaderPage, loader: () => ({ big: 10n }) },
])
