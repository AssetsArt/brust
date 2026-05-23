import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import os from 'node:os'
import HelloWorld from './components/HelloWorld'

import {
  brust,
  isWorker,
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
  // 256KB shared buffer per worker — Rust captures the backing-store pointer at
  // register time and reads from it after every render call.
  const sab = new SharedArrayBuffer(64 * 1024)
  const view = new Uint8Array(sab)
  const encoder = new TextEncoder()

  let wid = ''
  const id = brust.registerRenderer(view, async (path: string) => {
    const html = renderToString(
      createElement(HelloWorld, { workerId: wid })
    )
    const { written } = encoder.encodeInto(html, view)
    // written === undefined would mean the destination is too small; encodeInto
    // returns it as undefined only when there's no room for even one byte. Most
    // implementations always return a number — treat undefined as 0 (Rust 500).
    return written ?? 0
  })
  wid = String(id)
}
