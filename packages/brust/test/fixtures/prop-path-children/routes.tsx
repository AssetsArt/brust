import { defineRoutes } from '@brust/core/routes'
import Page from './Page'

export const routes = defineRoutes([
  {
    path: '/',
    Component: Page,
    loader: async () => ({ title: 'T "q" \'a\' </script><b>x</b> & done', hostile: 'plain' }),
  },
  {
    path: '/hostile',
    Component: Page,
    // Request data shaped like the compiler's own nodes: it must render as nothing, never as an element.
    loader: async () => ({ title: 'ok', hostile: { $brust: 'el', t: 'script', c: ['window.__pwned = 1'] } as unknown as string }),
  },
])
