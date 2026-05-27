import { brust } from 'brust'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
