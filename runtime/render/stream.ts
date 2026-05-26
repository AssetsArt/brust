import { renderToPipeableStream, renderToString } from 'react-dom/server'
import { createElement, type ReactNode, type ComponentType } from 'react'
import { Writable } from 'node:stream'
import { consumeIslandUsedFlag } from '../islands/island.tsx'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'

export interface RenderBranchStreamingArgs {
  element: ReactNode
  view: Uint8Array
  workerId: bigint
  napi: {
    renderChunk: (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
  }
  errorBoundary: ComponentType<{ error: Error }>
}

const encoder = new TextEncoder()

/** JSON.stringify the per-chunk meta. Defaults match the renderToString
 * path so single-chunk responses keep their existing wire shape. */
export function makeMeta(opts: {
  status: number
  streaming: boolean
  contentType?: string
  headers?: Record<string, string>
}): string {
  return JSON.stringify({
    status: opts.status,
    contentType: opts.contentType ?? 'text/html; charset=utf-8',
    headers: opts.headers ?? {},
    streaming: opts.streaming,
  })
}

/** Encode `[meta_len: u16 BE][meta][body]` into the SAB at offset 0;
 * return total byte length. Throws if it would exceed buf capacity. */
function encodeFirstChunk(view: Uint8Array, meta: string, body: Uint8Array): number {
  const metaBytes = encoder.encode(meta)
  const total = 2 + metaBytes.length + body.length
  if (total > view.length) {
    throw new Error(`first chunk ${total}b exceeds SAB ${view.length}b`)
  }
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  view.set(body, 2 + metaBytes.length)
  return total
}

function encodeBodyChunk(view: Uint8Array, body: Uint8Array): number {
  if (body.length > view.length) {
    throw new Error(`body chunk ${body.length}b exceeds SAB ${view.length}b`)
  }
  view.set(body, 0)
  return body.length
}

function concatBuffers(parts: Uint8Array[], withBootstrap: boolean): Uint8Array {
  const bootstrap = withBootstrap ? encoder.encode(ISLANDS_IMPORTMAP_AND_BOOTSTRAP) : null
  const totalLen = (bootstrap?.length ?? 0) + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(totalLen)
  let off = 0
  if (bootstrap) { out.set(bootstrap, off); off += bootstrap.length }
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

export function renderBranchStreaming(args: RenderBranchStreamingArgs): Promise<void> {
  const { element, view, workerId, napi, errorBoundary } = args

  // Reset the islands flag at the start of every render — the streaming path
  // (which doesn't read the flag at the end) would otherwise leak its setting
  // to the next render. consumeIslandUsedFlag() reads-and-resets so calling
  // here is safe; the actual read for the buffering path happens at _final
  // time and sees only flips made during THIS render's React work.
  consumeIslandUsedFlag()

  return new Promise<void>((resolve, reject) => {
    let finalSent = false
    const sendFinal = async () => {
      if (finalSent) return
      finalSent = true
      try { await napi.renderChunk(workerId, 0, view); resolve() }
      catch (e) { reject(e) }
    }

    let mode: 'buffering' | 'streaming' | 'done' = 'buffering'
    const buffer: Uint8Array[] = []

    // In streaming mode, body-chunk writes must wait for the header chunk
    // to be fully sent first. This promise gates all sink.write calls.
    let headerSent: Promise<void> | null = null

    const sink = new Writable({
      async write(chunk: Uint8Array, _enc: string, cb: (e?: Error | null) => void) {
        try {
          if (mode === 'buffering') {
            buffer.push(new Uint8Array(chunk))
            cb(); return
          }
          if (mode === 'streaming') {
            // Wait for the header chunk to be flushed before sending body chunks.
            if (headerSent) await headerSent
            const len = encodeBodyChunk(view, chunk)
            await napi.renderChunk(workerId, len, view)
          }
          cb()
        } catch (e) { cb(e as Error) }
      },
      async final(cb: (e?: Error | null) => void) {
        try {
          if (mode === 'buffering') {
            const islandsUsed = consumeIslandUsedFlag()
            const body = concatBuffers(buffer, islandsUsed)
            const meta = makeMeta({ status: 200, streaming: false })
            const len = encodeFirstChunk(view, meta, body)
            await napi.renderChunk(workerId, len, view)
            await sendFinal()
            mode = 'done'
          } else if (mode === 'streaming') {
            if (headerSent) await headerSent
            await sendFinal()
            mode = 'done'
          }
          cb()
        } catch (e) { cb(e as Error) }
      },
    })
    sink.on('error', reject)

    // Whether onAllReady has fired — set synchronously by React when there
    // is no pending Suspense (fires in the same tick as onShellReady).
    let allReadyFired = false
    let stream: ReturnType<typeof renderToPipeableStream>
    try {
      stream = renderToPipeableStream(element, {
        onShellReady() {
          // React fires onAllReady synchronously AFTER onShellReady in the
          // same microtask queue flush when there is no pending Suspense.
          // We defer our decision by one microtask so onAllReady has a
          // chance to run first.
          queueMicrotask(() => {
            if (allReadyFired) {
              // No pending Suspense — buffering path: pipe now so Writable
              // _final assembles the single chunk.
              stream.pipe(sink)
              return
            }
            // onAllReady hasn't fired yet → pending Suspense → streaming path.
            mode = 'streaming'
            const flushed = concatBuffers(buffer, true)
            buffer.length = 0
            const meta = makeMeta({ status: 200, streaming: true })
            // Send header chunk and pipe concurrently — writes gate on headerSent.
            let resolveHeader!: () => void
            let rejectHeader!: (e: unknown) => void
            headerSent = new Promise<void>((res, rej) => {
              resolveHeader = res; rejectHeader = rej
            })
            // Attach a no-op catch so a synchronous rejection from the IIFE doesn't
            // fire Node's unhandledRejection before a downstream await subscribes.
            // The actual error still flows through reject() of the outer Promise.
            headerSent.catch(() => {})
            // Pipe immediately so React can keep flushing resolved Suspense data.
            stream.pipe(sink)
            ;(async () => {
              try {
                const len = encodeFirstChunk(view, meta, flushed)
                await napi.renderChunk(workerId, len, view)
                resolveHeader()
              } catch (e) { rejectHeader(e); reject(e) }
            })()
          })
        },
        onAllReady() {
          allReadyFired = true
        },
        onShellError(err) {
          try {
            const html = renderToString(createElement(errorBoundary, { error: err as Error }))
            const meta = makeMeta({ status: 500, streaming: false })
            mode = 'done'
            ;(async () => {
              try {
                const len = encodeFirstChunk(view, meta, encoder.encode(html))
                await napi.renderChunk(workerId, len, view)
                await sendFinal()
              } catch (e) { reject(e) }
            })()
          } catch (e2) {
            console.error('[brust] errorBoundary threw during shell error:', e2)
            const meta = makeMeta({
              status: 500, streaming: false, contentType: 'text/plain; charset=utf-8',
            })
            mode = 'done'
            ;(async () => {
              try {
                const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
                await napi.renderChunk(workerId, len, view)
                await sendFinal()
              } catch (e) { reject(e) }
            })()
          }
        },
        onError(err) {
          console.error('[brust] render onError (post-shell):', err)
        },
      })
    } catch (e) {
      const meta = makeMeta({
        status: 500, streaming: false, contentType: 'text/plain; charset=utf-8',
      })
      ;(async () => {
        try {
          const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
          await napi.renderChunk(workerId, len, view)
          await sendFinal()
        } catch (ee) { reject(ee) }
      })()
    }
  })
}
