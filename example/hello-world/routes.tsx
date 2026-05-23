import { defineRoutes } from '../../runtime/routes.ts'
import HelloWorld from './components/HelloWorld'
import BlogPost from './components/BlogPost'
import Crash from './components/Crash'
import CrashBoundary from './components/CrashBoundary'

export const routes = defineRoutes([
  { path: '/',            Component: HelloWorld },
  { path: '/blog/{slug}', Component: BlogPost },
  { path: '/crash',       Component: Crash, errorBoundary: CrashBoundary },
])
