import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'
// Boot the 0.1.x runtime on the three bench pages. BRUST_PORT / BRUST_WORKERS come from the runner's env.
await brust.run({ routes, entry: import.meta.url })
