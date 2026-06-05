// react-dom/server.node: React 19's Node-streams SSR build (renderToPipeableStream).
// Bun routes bare 'react-dom/server' to the web-streams build, which lacks it. Pin
// every react-dom/server import to .node so one build loads. See routes.ts for detail.
import { renderToPipeableStream, renderToString } from 'react-dom/server.node'
import { createElement, type ReactNode, type ComponentType } from 'react'
import { Writable } from 'node:stream'
import { IslandUsedContext, createIslandUsedBox } from '../islands/island.tsx'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
import { injectCssLink } from './inject-css-link.ts'
import { getCssHrefs, getCssHrefsForRoute } from '../css.ts'
import { injectDevClient } from './inject-dev-client.ts'
import { injectActionPrefix, getActionPrefixSnippet } from './inject-action-prefix.ts'
import { injectBrustStore, buildStoreScripts } from './inject-store.ts'
import { getDevClientSnippet } from '../dev/inject.ts'

export interface RenderBranchStreamingArgs {
  element: ReactNode
  /** The render's SAB sub-view (whole buffer at slots=1). All chunk encodes
   * write at offset 0 of this view → automatically the slot's base. */
  view: Uint8Array
  /** The render slot index, passed to every napi.renderChunk* call so Rust
   * reads/writes the matching SAB sub-region. Default 0 (single-slot path). */
  slot?: number
  workerId: bigint
  napi: {
    renderChunk: (
      workerId: bigint,
      slot: number,
      len: number,
      sabBytes: Uint8Array,
    ) => Promise<void>
    renderChunkFinal: (
      workerId: bigint,
      slot: number,
      len: number,
      sabBytes: Uint8Array,
    ) => Promise<void>
  }
  errorBoundary: ComponentType<{ error: Error }>
  /** Status for the successful (non-error) render. Default 200. Used by
   * middleware-wrapped routes that want to set a non-200 status before
   * the component runs (e.g. 201 from a server action redirect). */
  status?: number
  /** Extra response headers injected by middleware (e.g. `x-render-ms`).
   * Merged into the meta envelope's `headers` map. */
  headers?: Record<string, string>
  /** The matched route's fullPath (e.g. '/' or '/blog/{slug}'). Used to
   * combine global CSS hrefs with per-route CSS hrefs before injection. */
  routePath?: string
  /** Per-request store snapshot collected after loaders run. Injected as a
   * `<script data-brust-store="…">` blob before `</head>` (buffering) or into
   * the streaming first-chunk prepend. Null/undefined → no injection. */
  storeSnapshot?: Record<string, Record<string, unknown>> | null
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
  if (bootstrap) {
    out.set(bootstrap, off)
    off += bootstrap.length
  }
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function renderBranchStreaming(args: RenderBranchStreamingArgs): Promise<void> {
  const { element, view, workerId, napi, errorBoundary } = args
  const slot = args.slot ?? 0
  const successStatus = args.status ?? 200
  const extraHeaders = args.headers ?? {}

  // Request-scoped islands signal: a fresh box per render, provided to every
  // <Island> through IslandUsedContext. The buffering path reads `box.used` at
  // _final to decide whether to prepend the importmap + bootstrap. Per-render
  // (not a module flag) so concurrent renders in one isolate (renderSlots>1)
  // never cross-contaminate — React restores each render's context across
  // Suspense resumption. No start-of-render reset needed: the box starts false.
  const islandUsedBox = createIslandUsedBox()
  const renderTree = createElement(IslandUsedContext.Provider, { value: islandUsedBox }, element)

  return new Promise<void>((resolve, reject) => {
    let finalSent = false
    const sendFinal = async () => {
      if (finalSent) return
      finalSent = true
      try {
        await napi.renderChunk(workerId, slot, 0, view)
        resolve()
      } catch (e) {
        reject(e)
      }
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
            cb()
            return
          }
          if (mode === 'streaming') {
            // Wait for the header chunk to be flushed before sending body chunks.
            if (headerSent) await headerSent
            const len = encodeBodyChunk(view, chunk)
            await napi.renderChunk(workerId, slot, len, view)
          }
          cb()
        } catch (e) {
          cb(e as Error)
        }
      },
      async final(cb: (e?: Error | null) => void) {
        try {
          if (mode === 'buffering') {
            const islandsUsed = islandUsedBox.used
            let body = concatBuffers(buffer, islandsUsed)
            const perRouteHrefs = args.routePath ? getCssHrefsForRoute(args.routePath) : []
            body = injectCssLink(body, [...getCssHrefs(), ...perRouteHrefs])
            body = injectDevClient(body, getDevClientSnippet())
            body = injectActionPrefix(body, getActionPrefixSnippet())
            body = injectBrustStore(body, args.storeSnapshot ?? null)
            const meta = makeMeta({
              status: successStatus,
              streaming: false,
              headers: extraHeaders,
            })
            const len = encodeFirstChunk(view, meta, body)
            await napi.renderChunkFinal(workerId, slot, len, view)
            finalSent = true
            resolve()
            mode = 'done'
          } else if (mode === 'streaming') {
            if (headerSent) await headerSent
            await sendFinal()
            mode = 'done'
          }
          cb()
        } catch (e) {
          cb(e as Error)
        }
      },
    })
    sink.on('error', reject)

    // Whether onAllReady has fired — set synchronously by React when there
    // is no pending Suspense (fires in the same tick as onShellReady).
    let allReadyFired = false
    let stream: ReturnType<typeof renderToPipeableStream>
    try {
      stream = renderToPipeableStream(renderTree, {
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
            let flushed = concatBuffers(buffer, true)
            buffer.length = 0
            // Streaming-only placement note: in the buffering branch we splice
            // <link> + dev <script> immediately before </head> (which is in the
            // accumulated body bytes). In streaming we can't — the first chunk
            // here is just the bootstrap prepend; </head> arrives in a later
            // React chunk that bypasses injection entirely. So we append the
            // link + dev tags after the bootstrap, before React's <!DOCTYPE>.
            // Browsers fetch the stylesheets and execute the script regardless
            // of position; quirks-mode is already engaged by the bootstrap
            // script's position so no new penalty.
            const perRouteHrefs = args.routePath ? getCssHrefsForRoute(args.routePath) : []
            const streamHrefs = [...getCssHrefs(), ...perRouteHrefs]
            const linkTagsStr = streamHrefs
              .map((h) => `<link rel="stylesheet" href="${h}">`)
              .join('')
            const devTag = getDevClientSnippet() ?? ''
            const prefixTag = getActionPrefixSnippet() ?? ''
            const storeTag = buildStoreScripts(args.storeSnapshot ?? null)
            if (
              linkTagsStr.length > 0 ||
              devTag.length > 0 ||
              prefixTag.length > 0 ||
              storeTag.length > 0
            ) {
              const prepend = encoder.encode(linkTagsStr + prefixTag + devTag + storeTag)
              const out = new Uint8Array(flushed.length + prepend.length)
              out.set(flushed, 0)
              out.set(prepend, flushed.length)
              flushed = out
            }
            const meta = makeMeta({ status: successStatus, streaming: true, headers: extraHeaders })
            // Send header chunk and pipe concurrently — writes gate on headerSent.
            let resolveHeader!: () => void
            let rejectHeader!: (e: unknown) => void
            headerSent = new Promise<void>((res, rej) => {
              resolveHeader = res
              rejectHeader = rej
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
                await napi.renderChunk(workerId, slot, len, view)
                resolveHeader()
              } catch (e) {
                rejectHeader(e)
                reject(e)
              }
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
                await napi.renderChunkFinal(workerId, slot, len, view)
                finalSent = true
                resolve()
              } catch (e) {
                reject(e)
              }
            })()
          } catch (e2) {
            console.error('[brust] errorBoundary threw during shell error:', e2)
            const meta = makeMeta({
              status: 500,
              streaming: false,
              contentType: 'text/plain; charset=utf-8',
            })
            mode = 'done'
            ;(async () => {
              try {
                const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
                await napi.renderChunkFinal(workerId, slot, len, view)
                finalSent = true
                resolve()
              } catch (e) {
                reject(e)
              }
            })()
          }
        },
        onError(err) {
          console.error('[brust] render onError (post-shell):', err)
        },
      })
    } catch (_e) {
      const meta = makeMeta({
        status: 500,
        streaming: false,
        contentType: 'text/plain; charset=utf-8',
      })
      ;(async () => {
        try {
          const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
          await napi.renderChunkFinal(workerId, slot, len, view)
          finalSent = true
          resolve()
        } catch (ee) {
          reject(ee)
        }
      })()
    }
  })
}
