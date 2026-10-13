import { defineRoutes } from '@brust/core/routes'
import ImpureMeta from './ImpureMeta'

export const routes = defineRoutes([{ path: '/', Component: ImpureMeta }])
