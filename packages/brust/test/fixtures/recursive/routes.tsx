import { defineRoutes } from '@brust/core/routes'
import { tree } from './data'
import Tree from './Tree'

export const routes = defineRoutes([{ path: '/', Component: Tree, loader: () => ({ nodes: tree }) }])
