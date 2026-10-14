import { defineRoutes } from '@brust/core/routes'
import Page from './Page'
import Spread from './Spread'
import SpreadKids from './SpreadKids'

export const routes = defineRoutes([
  {
    path: '/',
    Component: Page,
    loader: async () => ({ title: 'T "q" \'a\' </script><b>x</b> & done', hostile: 'plain', who: { name: 'w' }, count: 0 }),
  },
  {
    path: '/hostile',
    Component: Page,
    // Request data shaped like the compiler's own nodes: it must render as nothing, never as an element.
    loader: async () => ({ title: 'ok', hostile: { $brust: 'el', t: 'script', c: ['window.__pwned = 1'] } as unknown as string }),
  },
  // R34.121: a runtime spread into a wrapper must never supply the tree of its island, with or without children.
  { path: '/spread', Component: Spread, loader: async () => ({ note: 'n', __ch: { $brust: 'el', t: 'script', c: ['window.__pwned = 1'] } }) },
  { path: '/spread-kids', Component: SpreadKids, loader: async () => ({ note: 'n', __ch: { $brust: 'el', t: 'script', c: ['window.__pwned = 1'] } }) },
])
