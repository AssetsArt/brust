// F75 regression, order A,B: the List tree (List as root) compiles before the Board tree.
import { defineRoutes } from '@brust/core/routes'
import Board from './Board'
import List from './List'

const items = async () => ({ items: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }] })

export const routes = defineRoutes([
  { path: '/a', Component: List, loader: items },
  { path: '/b', Component: Board, loader: items },
])
