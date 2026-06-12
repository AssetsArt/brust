// Not-found integration fixture — a React `/` route + a global catch-all.
import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'

await brust.run({
  routes,
  entry: import.meta.url,
})
