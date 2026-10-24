import { defineRoutes } from '@brust/core/routes'
import CrumbPage from './CrumbPage'
import ElementPage from './ElementPage'
import LePage from './LePage'
import PresencePage from './PresencePage'

export default defineRoutes([{ path: '/presence', Component: PresencePage }, { path: '/le', Component: LePage }, { path: '/element', Component: ElementPage }, { path: '/crumb', Component: CrumbPage }])
