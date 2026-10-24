import { defineRoutes } from '@brust/core/routes'
import Page from './Page'

// The props every expression of Page.tsx reads (tests/server/js-operators.test.ts has the same table).
export const routes = defineRoutes([
  { path: '/', Component: Page, loader: async () => ({ s: '10', t: '9', n: 9, q: '9', nl: null, zero: 0, b: true, x: 3, big: 1e308 }) },
])
