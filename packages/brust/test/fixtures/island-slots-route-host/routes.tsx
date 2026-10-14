import { defineRoutes } from '@brust/core/routes'
import Other from './Other'
import Shell from './Shell'

export const routes = defineRoutes([
  { path: '/', Component: Shell, loader: async () => ({ title: 't', data: { $brust: 'el', t: 'u', p: {}, c: ['pwn'] } }) },
  { path: '/other', Component: Other },
])
