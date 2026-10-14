import { defineRoutes } from '@brust/core/routes'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import ShadcnPage from './pages/ShadcnPage'

export const routes = defineRoutes([{ Component: Layout, children: [{ path: '/', Component: HomePage }, { path: '/ui', Component: ShadcnPage }] }])
