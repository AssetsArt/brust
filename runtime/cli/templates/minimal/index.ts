import { brust } from 'brustjs'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
