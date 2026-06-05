import { Suspense, type ReactNode } from 'react'
import Layout from '../../_shared/Layout'

// Per-request-FRESH async-data Suspense route — the ONLY shape that
// multi-render-per-worker speeds up: while one render awaits its data, a peer
// render on another slot uses the idle isolate. The wait is I/O (a timer), so
// renderSlots>1 overlaps the waits across slots. Default ~25ms ≈ a fast DB/API
// hop; override with BENCH_SUSPENSE_MS.
//
// Probe this at BRUST_RENDER_SLOTS=1 vs a higher value: synchronous routes are
// unchanged (they serialize on CPU), but THIS route's throughput scales with
// slots until the isolate's CPU saturates.
const DELAY_MS = Number(process.env.BENCH_SUSPENSE_MS) || 25

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

function DataChild({ resource }: { resource: Resource }): ReactNode {
  return <p data-testid="data">fetched: {read(resource)}</p>
}

export default function SuspenseData(): ReactNode {
  // Fresh promise per render (per request): the route component creates it and
  // passes it as a prop, so it is stable across Suspense retries WITHIN a render
  // but independent ACROSS requests — letting concurrent requests overlap.
  const resource = new Promise<string>((resolve) => {
    setTimeout(() => resolve(`row after ${DELAY_MS}ms`), DELAY_MS)
  }) as Resource
  return (
    <Layout title="Suspense data bench">
      <h1>Suspense data route</h1>
      <Suspense fallback={<p data-testid="loading">loading…</p>}>
        <DataChild resource={resource} />
      </Suspense>
    </Layout>
  )
}
