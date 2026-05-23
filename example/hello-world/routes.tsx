import { defineRoutes } from '../../runtime/routes.ts'
import HelloWorld    from './components/HelloWorld'
import BlogPost      from './components/BlogPost'
import Crash         from './components/Crash'
import CrashBoundary from './components/CrashBoundary'
import CacheTest     from './components/CacheTest'

export const routes = defineRoutes([
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost },
  { path: '/crash',        Component: Crash, errorBoundary: CrashBoundary },
  { path: '/cache-test',   Component: CacheTest, cache: { ttl_seconds: 60 } },
])
