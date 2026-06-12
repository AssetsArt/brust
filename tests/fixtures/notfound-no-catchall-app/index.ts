// Not-found fixture with NO catch-all — exercises the React notFound() default
// 404 body fallback.
import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'

await brust.run({
  routes,
  entry: import.meta.url,
})
