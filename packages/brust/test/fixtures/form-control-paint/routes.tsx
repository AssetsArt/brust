import { defineRoutes } from '@brust/core/routes'
import SelectPage from './SelectPage'
import TextareaPage from './TextareaPage'

export const routes = defineRoutes([
  { path: '/select', Component: SelectPage },
  { path: '/textarea', Component: TextareaPage },
])
