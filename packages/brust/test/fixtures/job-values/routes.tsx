import { defineRoutes } from '@brust/core/routes'
import Client from './Client'
import Server from './Server'

export const routes = defineRoutes([
  { path: '/s/{k}', Component: Server, loader: ({ params }: any) => ({ x: params.k }) },
  { path: '/c/{k}', Component: Client, loader: ({ params }: any) => ({ x: params.k }) },
])
