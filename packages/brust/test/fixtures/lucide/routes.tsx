import { defineRoutes } from '@brust/core/routes'
import DynProvider from './DynamicProvider'
import Fallback from './Fallback'
import NativeIcon from './Native'
import NativeUndefined from './NativeUndef'
import Provided from './Provider'
import StaticIcons from './Static'
import UndefinedProps from './Undefined'

export const routes = defineRoutes([
  { path: '/', Component: StaticIcons, loader: () => ({ big: 40, tone: 'teal' }) },
  { path: '/undefined', Component: UndefinedProps, loader: () => ({}) },
  { path: '/defined', Component: UndefinedProps, loader: () => ({ s: 12, c: 'navy', w: 1, k: 'k1' }) },
  { path: '/native-undefined', Component: NativeUndefined },
  { path: '/native', Component: NativeIcon },
  { path: '/provider', Component: Provided },
  { path: '/dynprovider', Component: DynProvider, loader: () => ({ size: 12 }) },
  { path: '/fallback', Component: Fallback, loader: () => ({ label: 'x' }) },
])
