import { defineRoutes } from '@brust/core/routes'
import PHandler from './p_handler'
import PLinkedChild from './p_linked_child'
import PList from './p_list'
import PState from './p_state'
import PText from './p_text'
import PProv from './p_prov'
import PChain from './p_chain'

export const routes = defineRoutes([
  { path: '/state', Component: PState },
  { path: '/text', Component: PText },
  { path: '/handler', Component: PHandler },
  { path: '/linked', Component: PLinkedChild },
  { path: '/list', Component: PList },
  { path: '/prov', Component: PProv },
  { path: '/chain', Component: PChain },
])
