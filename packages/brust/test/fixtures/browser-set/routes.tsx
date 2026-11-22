import { defineRoutes } from '@brust/core/routes'
import { loader } from './loader'
import Pick from './Pick'

export const routes = defineRoutes([{ path: '/', Component: Pick, loader }])
