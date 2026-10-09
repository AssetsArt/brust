// A child with its own job inside two lists: lowering Error `nested-instance`.
import { defineRoutes } from '@brust/brust/routes'
import Grid from './Grid'

export default defineRoutes([{ path: '/', Component: Grid }])
