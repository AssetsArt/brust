import { defineRoutes } from '@brust/brust/routes'
import Counter from './Counter'

export const routes = defineRoutes([{ path: '/', Component: Counter, loader: () => ({ label: 'x' }) }])
