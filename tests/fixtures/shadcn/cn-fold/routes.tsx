// F149 (cn-fold) started-server proof: tests/server/cn-fold.test.ts. Every shadcn page with an inlined instance that
// has a precompute job (27 at the time of the lane), one route each.
import { defineRoutes } from '@brust/core/routes'
import AlertPage from '../pages/alert'
import AttachmentPage from '../pages/attachment'
import BadgePage from '../pages/badge'
import BadgeAslinkPage from '../pages/badge-aslink'
import BreadcrumbPage from '../pages/breadcrumb'
import BubblePage from '../pages/bubble'
import ButtonPage from '../pages/button'
import ButtonAschildPage from '../pages/button-aschild'
import ButtonGroupPage from '../pages/button-group'
import CardPage from '../pages/card'
import CheckboxPage from '../pages/checkbox'
import EmptyPage from '../pages/empty'
import FieldPage from '../pages/field'
import InputPage from '../pages/input'
import InputGroupPage from '../pages/input-group'
import ItemPage from '../pages/item'
import KbdPage from '../pages/kbd'
import LabelPage from '../pages/label'
import MarkerPage from '../pages/marker'
import MessagePage from '../pages/message'
import NativeSelectPage from '../pages/native-select'
import PaginationPage from '../pages/pagination'
import SkeletonPage from '../pages/skeleton'
import SonnerPage from '../pages/sonner'
import SwitchPage from '../pages/switch'
import TablePage from '../pages/table'
import TextareaPage from '../pages/textarea'

export const routes = defineRoutes([
  { path: '/alert', Component: AlertPage },
  { path: '/attachment', Component: AttachmentPage },
  { path: '/badge', Component: BadgePage },
  { path: '/badge-aslink', Component: BadgeAslinkPage },
  { path: '/breadcrumb', Component: BreadcrumbPage },
  { path: '/bubble', Component: BubblePage },
  { path: '/button', Component: ButtonPage },
  { path: '/button-aschild', Component: ButtonAschildPage },
  { path: '/button-group', Component: ButtonGroupPage },
  { path: '/card', Component: CardPage },
  { path: '/checkbox', Component: CheckboxPage },
  { path: '/empty', Component: EmptyPage },
  { path: '/field', Component: FieldPage },
  { path: '/input', Component: InputPage },
  { path: '/input-group', Component: InputGroupPage },
  { path: '/item', Component: ItemPage },
  { path: '/kbd', Component: KbdPage },
  { path: '/label', Component: LabelPage },
  { path: '/marker', Component: MarkerPage },
  { path: '/message', Component: MessagePage },
  { path: '/native-select', Component: NativeSelectPage },
  { path: '/pagination', Component: PaginationPage },
  { path: '/skeleton', Component: SkeletonPage },
  { path: '/sonner', Component: SonnerPage },
  { path: '/switch', Component: SwitchPage },
  { path: '/table', Component: TablePage },
  { path: '/textarea', Component: TextareaPage },
])
