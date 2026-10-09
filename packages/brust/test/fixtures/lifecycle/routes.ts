// Alternate worker entry for test/lifecycle.test.ts: the fixture app's route tree (same shape →
// same route ids as its manifest), with an item loader that can kill its worker or report the
// worker's environment.
import { defineRoutes } from '@brust/core/routes'
import AppLayout from '../app/AppLayout'
import HomePage from '../app/HomePage'
import ItemPage from '../app/ItemPage'

const item = (name: string) => ({ item: { id: 'x', name, price: 1, rows: [] }, unit: '', team: [] })

async function loader({ params }: { params: { id: string } }) {
  if (params.id === 'die') process.exit(3)
  if (params.id === 'env') {
    const prod = Object.keys(require.cache).some((k) => /react-dom-server[^/]*\.production\./.test(k))
    return item(`NODE_ENV=${process.env.NODE_ENV} react-dom-server.production=${prod}`)
  }
  return item(`Item ${params.id}`)
}

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage },
      { path: '/items/{id}', Component: ItemPage, loader },
    ],
  },
])
