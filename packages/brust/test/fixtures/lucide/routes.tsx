import { defineRoutes } from '@brust/core/routes'
import DynProvider from './DynamicProvider'
import Fallback from './Fallback'
import NativeIcon from './Native'
import Provided from './Provider'
import StaticIcons from './Static'

export const routes = defineRoutes([
  { path: '/', Component: StaticIcons, loader: () => ({ big: 40, tone: 'teal' }) },
  { path: '/native', Component: NativeIcon },
  { path: '/provider', Component: Provided },
  { path: '/dynprovider', Component: DynProvider, loader: () => ({ size: 12 }) },
  { path: '/fallback', Component: Fallback, loader: () => ({ label: 'x' }) },
])
