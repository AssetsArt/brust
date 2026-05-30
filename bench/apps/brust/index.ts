import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'

// Dedicated brust benchmark app — decoupled from example/hello-world so bench
// numbers don't drift when the demo changes. Serves ONLY the routes the bench
// probes hit: `/` (React SSR), `/native-profile/{user}` (native jinja),
// `/native-islands` (native + islands), and the `createNote` action. `/ping`
// is the built-in Rust path.
// BRUST_WORKERS (read by loadConfig) sets render-thread count. BRUST_CONN_WORKERS
// (optional) sets the Rust I/O concurrency separately via ServeOptions.tuning —
// lets the bench drive render vs conn workers independently.
const connWorkers = process.env.BRUST_CONN_WORKERS
  ? parseInt(process.env.BRUST_CONN_WORKERS, 10)
  : undefined

await brust.run({
  routes,
  entry: import.meta.url,
  ...(connWorkers ? { serve: { tuning: { connWorkers } } } : {}),
})
