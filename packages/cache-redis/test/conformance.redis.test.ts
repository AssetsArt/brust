import { afterAll, describe } from 'bun:test'
import { runConformance } from '@brust/core/cache-adapter/conformance'
import { make, sweep } from './servers'

const url = process.env.BRUST_REDIS_URL
const required = process.env.BRUST_REDIS_REQUIRED === '1'
if (!url && required) throw new Error('BRUST_REDIS_REQUIRED=1 but BRUST_REDIS_URL is not set')

afterAll(sweep)

// The suite calls init (namespace "conformance") and close itself; the adapter is built uninitialised.
describe.skipIf(!url)('redis', () => {
  runConformance(() => make('redis', url!, {}, 'conformance', false), { push: true, guard: true })
})
