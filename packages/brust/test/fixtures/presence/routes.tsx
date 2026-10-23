import { defineRoutes } from '@brust/core/routes'
import LePage from './LePage'
import PresencePage from './PresencePage'

export default defineRoutes([{ path: '/presence', Component: PresencePage }, { path: '/le', Component: LePage }])
