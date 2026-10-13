import { defineRoutes } from '@brust/core/routes'
import Client from './Client'

export const routes = defineRoutes([{ path: '/', Component: Client }])
