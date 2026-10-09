// A layout that renders <Outlet/> mounted as a leaf: `outlet-outside-layout` (contract 5).
import { defineRoutes } from '@brust/brust/routes'
import AppLayout from './AppLayout'

export const routes = defineRoutes([{ path: '/', Component: AppLayout }])
