import { defineRoutes } from '@brust/core/routes'
import SelectPage from './SelectPage'
import SpreadPage from './SpreadPage'
import TextareaPage from './TextareaPage'

export const routes = defineRoutes([
  { path: '/select', Component: SelectPage },
  { path: '/spread', Component: SpreadPage },
  { path: '/textarea', Component: TextareaPage },
])
