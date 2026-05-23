import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import os from 'node:os'
import HelloWorld from './components/HelloWorld'

import {
  brust,
  isWorker,
  workerId,
} from '../../runtime/index.ts'

const PORT_ENV = process.env.BRUST_PORT
const port = PORT_ENV ? parseInt(PORT_ENV, 10) : 3000
// Oversubscribe by 1.8× available cores: napi workers spend ~45% of wall time
// in V8 GC / IPC / thread-park; the extra workers keep CPU saturated during
// those pauses. Measured peak on M1 Pro (10C) at this ratio.
const defaultWorkers = Math.floor(os.availableParallelism() * 1.8)
const workers = parseInt(process.env.BRUST_WORKERS ?? String(defaultWorkers), 10)

if (!isWorker) {
  console.log(`[brust] main: spawning ${workers} worker threads`)
  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
} else {
  brust.registerRenderer(async (path: string) => {
    return renderToString(
      createElement(HelloWorld, { workerId: workerId()?.toString() ?? '' })
    )
  })
}
