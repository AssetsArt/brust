// F183 (jobs-prune) started-server proof: tests/server/cn-fold.test.ts. The 19 pages of `routes.tsx` that plan no job
// once their class jobs are folded at build: no route reaches a job, so the build needs no worker.
import { defineRoutes } from '@brust/core/routes'
import AlertPage from '../pages/alert'
import AttachmentPage from '../pages/attachment'
import BadgePage from '../pages/badge'
import BadgeAslinkPage from '../pages/badge-aslink'
import BubblePage from '../pages/bubble'
import ButtonPage from '../pages/button'
import ButtonAschildPage from '../pages/button-aschild'
import CardPage from '../pages/card'
import EmptyPage from '../pages/empty'
import FieldPage from '../pages/field'
import InputPage from '../pages/input'
import ItemPage from '../pages/item'
import KbdPage from '../pages/kbd'
import LabelPage from '../pages/label'
import MarkerPage from '../pages/marker'
import MessagePage from '../pages/message'
import SkeletonPage from '../pages/skeleton'
import TablePage from '../pages/table'
import TextareaPage from '../pages/textarea'

export const routes = defineRoutes([
  { path: '/alert', Component: AlertPage },
  { path: '/attachment', Component: AttachmentPage },
  { path: '/badge', Component: BadgePage },
  { path: '/badge-aslink', Component: BadgeAslinkPage },
  { path: '/bubble', Component: BubblePage },
  { path: '/button', Component: ButtonPage },
  { path: '/button-aschild', Component: ButtonAschildPage },
  { path: '/card', Component: CardPage },
  { path: '/empty', Component: EmptyPage },
  { path: '/field', Component: FieldPage },
  { path: '/input', Component: InputPage },
  { path: '/item', Component: ItemPage },
  { path: '/kbd', Component: KbdPage },
  { path: '/label', Component: LabelPage },
  { path: '/marker', Component: MarkerPage },
  { path: '/message', Component: MessagePage },
  { path: '/skeleton', Component: SkeletonPage },
  { path: '/table', Component: TablePage },
  { path: '/textarea', Component: TextareaPage },
])
