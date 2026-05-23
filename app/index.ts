import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import HelloWorld from '../runtime/components/HelloWorld'

import {
  brust,
  isWorker,
  workerId,
} from '../runtime/index.ts'

const PORT_ENV = process.env.BRUST_PORT
const port = PORT_ENV ? parseInt(PORT_ENV, 10) : 3000
const workers = parseInt(process.env.BRUST_WORKERS ?? '8', 10)

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
      createElement(HelloWorld, { workerId: String(workerId) })
    )
  })
}
