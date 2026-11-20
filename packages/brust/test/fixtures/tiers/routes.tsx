// F569: an app with one component of each tier, a named export, and a React copy (`_r`) of a native component.
import { defineRoutes } from '@brust/core/routes'
import Home from './pages/Home'
import ShellPage from './pages/ShellPage'

export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/shell', Component: ShellPage, loader: () => ({ title: 'a', tone: 'b' }) },
])
