import { brust } from 'brustjs'
import { actions } from './actions'
import { routes } from './routes'

// Boot: register native routes + the docs JSON API actions, compile native
// templates, build directive/island chunks, and serve. Zero config.
await brust.run({
  routes,
  entry: import.meta.url,
  actions,
})
