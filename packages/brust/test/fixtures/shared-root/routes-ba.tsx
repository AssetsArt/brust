// F75 regression, order B,A: the Board tree (List as linked child) compiles first.
import { defineRoutes } from '@brust/core/routes'
import Board from './Board'
import List from './List'

const items = async () => ({ items: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }] })

export const routes = defineRoutes([
  { path: '/b', Component: Board, loader: items },
  { path: '/a', Component: List, loader: items },
])
