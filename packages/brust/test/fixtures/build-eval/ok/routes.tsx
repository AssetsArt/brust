import { defineRoutes } from '@brust/core/routes'
import BuildTimePage from './BuildTime'
import Impure from './Impure'
import ImpureImports from './ImpureImports'
import Pure from './Pure'
import PropsBuildTime from './PropsBuildTime'

export const routes = defineRoutes([
  { path: '/', Component: Pure },
  { path: '/impure', Component: Impure },
  { path: '/impure-imports', Component: ImpureImports },
  { path: '/bt', Component: BuildTimePage },
  { path: '/props', Component: PropsBuildTime, loader: () => ({ code: 'x' }) },
])
