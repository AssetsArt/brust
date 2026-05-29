import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'

// Dedicated brust benchmark app — decoupled from example/hello-world so bench
// numbers don't drift when the demo changes. Serves ONLY the routes the bench
// probes hit: `/` (React SSR), `/native-profile/{user}` (native jinja),
// `/native-islands` (native + islands), and the `createNote` action. `/ping`
// is the built-in Rust path.
await brust.run({
  routes,
  entry: import.meta.url,
})
