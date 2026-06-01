import { Suspense, type JSX } from 'react'
import Layout from '../components/Layout'

// Cache the resolved promise per process so reloads don't pile up new ones.
let cached: Promise<string> | null = null

function slowFetch(): Promise<string> {
  if (cached) return cached
  cached = new Promise<string>((resolve) => {
    setTimeout(() => resolve('Resolved after 200ms via Suspense streaming'), 200)
  })
  return cached
}

function SlowChild(): JSX.Element {
  const promise = slowFetch()
  // React 18 SSR Suspense: throw the Promise to suspend until it settles.
  if ((promise as any).status !== 'fulfilled') {
    promise.then((v) => {
      ;(promise as any).status = 'fulfilled'
      ;(promise as any).value = v
    })
    throw promise
  }
  return <p data-testid="slow-content">{(promise as any).value}</p>
}

export default function SlowSuspense(): JSX.Element {
  return (
    <Layout title="Streaming demo">
      <h1>Streaming demo</h1>
      <p>
        The shell (this layout + the fallback below) ships in the first chunk under{' '}
        <code>Transfer-Encoding: chunked</code>. The resolved content streams in as a later chunk,
        ~200 ms after handshake.
      </p>
      <Suspense
        fallback={
          <p data-testid="spinner" className="text-gray-500 italic">
            loading...
          </p>
        }
      >
        <SlowChild />
      </Suspense>
    </Layout>
  )
}
