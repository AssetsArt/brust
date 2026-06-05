import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'
import { actions } from './actions'

// Dedicated brust benchmark app — decoupled from example/hello-world so bench
// numbers don't drift when the demo changes. Serves ONLY the routes the bench
// probes hit: `/` (React SSR), `/native-profile/{user}` (native jinja),
// `/native-islands` (native + islands), and the `createNote` action. `/ping`
// is the built-in Rust path.
// BRUST_WORKERS (read by loadConfig) sets render-thread count. BRUST_CONN_WORKERS
// (optional) sets the Rust I/O concurrency separately via ServeOptions.tuning —
// lets the bench drive render vs conn workers independently.
// BRUST_CONN_WORKERS → accept concurrency; BRUST_WORKER_THREADS → tokio I/O
// runtime thread count (default min(availableParallelism,4)). Both feed
// ServeOptions.tuning so the bench can sweep them independently of BRUST_WORKERS
// (the Bun render-thread count).
const connWorkers = process.env.BRUST_CONN_WORKERS
  ? parseInt(process.env.BRUST_CONN_WORKERS, 10)
  : undefined
const workerThreads = process.env.BRUST_WORKER_THREADS
  ? parseInt(process.env.BRUST_WORKER_THREADS, 10)
  : undefined
// BRUST_RENDER_SLOTS → in-flight renders per worker (multi-render-per-worker).
// Lets the bench sweep concurrency-per-isolate; the win shows on Suspense /
// async-data routes (synchronous pages serialize on CPU and see no gain).
const renderSlots = process.env.BRUST_RENDER_SLOTS
  ? parseInt(process.env.BRUST_RENDER_SLOTS, 10)
  : undefined

const tuning = {
  ...(connWorkers ? { connWorkers } : {}),
  ...(workerThreads ? { workerThreads } : {}),
  ...(renderSlots ? { renderSlots } : {}),
}

await brust.run({
  routes,
  entry: import.meta.url,
  actions,
  ...(Object.keys(tuning).length > 0 ? { serve: { tuning } } : {}),
})
