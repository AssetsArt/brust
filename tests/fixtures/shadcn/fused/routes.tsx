// R34.96 PR 2b (job fusion) started-server proof: tests/server/fused-jobs.test.ts. The shadcn pages a fused child
// moved off React (pagination, input-group, button-group, field, separator), one route each.
import { defineRoutes } from '@brust/core/routes'
import ButtonGroupPage from '../pages/button-group'
import ChildrenLabelPage from './children-label'
import FieldPage from '../pages/field'
import InputGroupPage from '../pages/input-group'
import PaginationPage from '../pages/pagination'
import SeparatorPage from '../pages/separator'

export const routes = defineRoutes([
  { path: '/button-group', Component: ButtonGroupPage },
  { path: '/children-label', Component: ChildrenLabelPage },
  { path: '/field', Component: FieldPage },
  { path: '/input-group', Component: InputGroupPage },
  { path: '/pagination', Component: PaginationPage },
  { path: '/separator', Component: SeparatorPage },
])
