// The custom adapter: a client of the test relay (one shared memory adapter for every process).
import { relayAdapter } from './lib/relay-client'

export default () => relayAdapter(process.env.BRUST_L2_RELAY ?? 'http://127.0.0.1:1')
