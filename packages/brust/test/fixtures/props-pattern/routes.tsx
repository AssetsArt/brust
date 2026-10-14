import { defineRoutes } from '@brust/core/routes'
import Call from './Call'
import Const from './Const'
import Earlier from './Earlier'
import Iife from './Iife'
import Jsx from './Jsx'
import Ok from './Ok'
import Quoted from './Quoted'

export const routes = defineRoutes([
  { path: '/call', Component: Call },
  { path: '/const', Component: Const },
  { path: '/earlier', Component: Earlier },
  { path: '/iife', Component: Iife },
  { path: '/jsx', Component: Jsx },
  { path: '/ok', Component: Ok },
  { path: '/quoted', Component: Quoted },
])
