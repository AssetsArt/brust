import { brust } from '../../runtime/index.ts'
import { routes } from './routes'
import { actions } from './actions'

await brust.run({
  routes,
  entry: import.meta.url,
  actions,
})
