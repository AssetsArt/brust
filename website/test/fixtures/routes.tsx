// Test fixture routes: the site layout around the foundation page, plus the site's 404.
import { defineRoutes } from '@brust/core/routes'
import Layout, { layoutLoader } from '../../components/Layout'
import NotFoundPage from '../../pages/NotFoundPage'
import FoundationPage, { foundationLoader } from './FoundationPage'

export const routes = defineRoutes([
  { Component: Layout, loader: layoutLoader, children: [{ path: '/foundation', Component: FoundationPage, loader: foundationLoader }] },
  { path: '*', Component: NotFoundPage },
])
