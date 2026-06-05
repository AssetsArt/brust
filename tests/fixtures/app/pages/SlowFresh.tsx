import { Suspense, type ReactNode } from 'react'
import Layout from '../components/Layout'

const DELAY_MS = 200

// Per-render-FRESH Suspense resource (contrast with SlowSuspense, which caches
// one promise per process). The route component creates a new promise on every
// render (every HTTP request) and passes it as a prop; React preserves that prop
// across Suspense retries of the child, so the promise is stable WITHIN one
// render but fresh ACROSS requests. That independence is what lets two
// concurrent renders each suspend on their own ~150ms wait — so under
// renderSlots>1 the waits OVERLAP (the multi-render-per-worker interleave proof).
type Resource = Promise<string> & {
  status?: 'pending' | 'fulfilled' | 'rejected'
  value?: string
  reason?: unknown
}

function read(resource: Resource): string {
  if (resource.status === 'fulfilled') return resource.value as string
  if (resource.status === 'rejected') throw resource.reason
  if (!resource.status) {
    resource.status = 'pending'
    resource.then(
      (v) => {
        resource.status = 'fulfilled'
        resource.value = v
      },
      (e) => {
        resource.status = 'rejected'
        resource.reason = e
      },
    )
  }
  throw resource
}

function FreshChild({ resource }: { resource: Resource }): ReactNode {
  return <p data-testid="fresh-content">{read(resource)}</p>
}

export default function SlowFresh(): ReactNode {
  const resource = new Promise<string>((resolve) => {
    setTimeout(() => resolve(`fresh after ${DELAY_MS}ms`), DELAY_MS)
  }) as Resource
  return (
    <Layout title="Fresh streaming demo">
      <h1>Fresh streaming demo</h1>
      <Suspense fallback={<p data-testid="fresh-spinner">loading...</p>}>
        <FreshChild resource={resource} />
      </Suspense>
    </Layout>
  )
}
