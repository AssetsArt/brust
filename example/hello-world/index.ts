import { brust } from '../../runtime/index.ts'
import { routes } from './routes'

await brust.run({
  routes,
  entry: import.meta.url,
})
