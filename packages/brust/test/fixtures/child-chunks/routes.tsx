// Ledger F66: a native child with a client chunk but no precompute job and no useId has no
// instances[] record; the build must still link its chunk (a static children[] entry on the
// chain component), transitively, once per page — and never for a chunk-less child.
import { defineRoutes } from '@brust/core/routes'
import AllStatic from './AllStatic'
import Page from './Page'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/static', Component: AllStatic },
])
