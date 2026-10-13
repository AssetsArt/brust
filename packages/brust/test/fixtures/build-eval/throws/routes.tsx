import { defineRoutes } from '@brust/core/routes'
import Throws from './Throws'

export const routes = defineRoutes([{ path: '/', Component: Throws }])
