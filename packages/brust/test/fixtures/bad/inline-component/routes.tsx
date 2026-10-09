// A Component declared inline has no .tsx file to compile: `component-source`.
import { defineRoutes } from '@brust/brust/routes'

export const routes = defineRoutes([{ path: '/', Component: () => <p /> }])
