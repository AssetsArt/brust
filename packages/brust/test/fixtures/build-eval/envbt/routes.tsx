import { defineRoutes } from '@brust/core/routes'
import EnvBt from './EnvBt'

export const routes = defineRoutes([{ path: '/', Component: EnvBt }])
