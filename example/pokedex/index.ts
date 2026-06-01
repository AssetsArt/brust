import { brust } from '../../runtime/index.ts'
import { actions } from './actions'
import { routes } from './routes'

// Boot: register the (native) routes + the team-store actions, build island
// chunks, compile native templates, and serve. Zero config — PokeAPI is public
// and keyless, so this runs out of the box.
await brust.run({
  routes,
  entry: import.meta.url,
  actions,
})
