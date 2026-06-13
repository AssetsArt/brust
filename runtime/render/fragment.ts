// Fragment rendering — render a React tree to a single awaited HTML string.
//
// Two consumers:
//  - routes.ts navigationBranch (SPA-nav payloads) — imports renderToAwaitedString.
//  - the public `renderFragment` API (R4) — render a component to static HTML
//    with the framework's request/store/loader-cache contexts scoped per call.
//
// React 19 split react-dom/server by runtime: under Bun the bare
// 'react-dom/server' resolves to the web-streams build (server.bun.js), which
// only exports renderToReadableStream. renderToPipeableStream (Node streams —
// what our Writable sink + onAllReady/onShellReady path uses) lives in the
// .node build. Import it explicitly so SSR works on the react@19 we declare as
// a peer (React 18 shipped renderToPipeableStream in the bun build, which is
// why this was silently fine).
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToPipeableStream } from 'react-dom/server.node'
import { Writable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { runInRequestScope } from '../request-context.ts'
import { runInRequestCache } from '../loader-cache.ts'
import { runInStoreContext } from '../store/server-context.ts'

/** Render a React element to a single HTML string, awaiting all Suspense
 * boundaries via onAllReady. Used by navigationBranch — renderToString
 * would only capture the shell + fallbacks, while renderBranchStreaming
 * is for the streaming render path. */
export function renderToAwaitedString(element: ReactNode): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        cb()
      },
    })
    sink.on('finish', () => resolve(Buffer.concat(chunks).toString('utf8')))
    sink.on('error', reject)

    let stream: ReturnType<typeof renderToPipeableStream>
    stream = renderToPipeableStream(element, {
      onAllReady() {
        try {
          stream.pipe(sink)
        } catch (e) {
          reject(e)
        }
      },
      onShellError(err) {
        reject(err)
      },
      onError(err) {
        // Logged at the navigationBranch level; let onAllReady drive completion.
        console.error('[brust] navigation render onError:', err)
      },
    })
  })
}

export interface RenderFragmentOpts {
  /** Request cookies visible to cookies()/session helpers inside the tree. */
  cookies?: Record<string, string>
}

/** Render a component to an HTML string with framework contexts scoped:
 * request scope (cookies) ∘ request cache (cachedFetch/dedupe) ∘ store
 * context (fresh per call — no cross-call leakage; concurrency-safe via
 * AsyncLocalStorage). Suspense supported — the promise resolves when the
 * whole tree is ready, never with fallbacks. Static HTML only: no island
 * hydration markers/scripts (an `<Island>` inside the fragment SSRs its
 * component but ships no hydration), no head/CSS collection, no streaming.
 * Native/jinja fragments are served by `templates.render` instead.
 * Errors reject with the component's error — no error-boundary semantics. */
export async function renderFragment<P extends object>(
  Component: ComponentType<P>,
  props: P,
  opts?: RenderFragmentOpts,
): Promise<string> {
  // Composition mirrors routes.ts runInRequestContext: scope outermost, then
  // the request-scoped loader cache, then the per-call store context.
  return runInRequestScope(opts?.cookies ?? {}, () =>
    runInRequestCache(() =>
      runInStoreContext(() =>
        renderToAwaitedString(createElement(Component as ComponentType, props as object)),
      ),
    ),
  )
}
