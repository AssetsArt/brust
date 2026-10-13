import { defineRoutes } from '@brust/core/routes'
import Exprs from './Exprs'
import Literals from './Literals'
import Reactive from './Reactive'

export const routes = defineRoutes([
  { path: '/', Component: Literals },
  {
    path: '/exprs',
    Component: Exprs,
    loader: async () => ({
      head: 'hi',
      files: [
        { name: 'a', body: '  x\ny  ', lang: 'rs' },
        { name: 'b', body: 'z\n\nw' },
      ],
    }),
  },
  { path: '/reactive', Component: Reactive, loader: async () => ({ src: 'r\ns' }) },
])
