import { defineRoutes } from '@brust/core/routes'
import Page from './Page'

export const routes = defineRoutes([{ path: '/p/{k}', Component: Page, loader: ({ params }: any) => ({ x: params.k }) }])
