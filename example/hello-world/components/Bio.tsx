interface BioProps {
  /** A promise resolved server-side. Pass a fresh promise per render —
   * Brust's render path is request-scoped so reusing one would tie all
   * requests to the same data. */
  promise: Promise<string>
}

/** Async-data component pattern (React 18 SSR): suspend the renderer by
 * throwing the pending promise; React catches it at the surrounding
 * `<Suspense>` boundary and ships the fallback. When the promise settles
 * we annotate it with `.status`/`.value` so the next render returns the
 * resolved markup synchronously instead of suspending again. The newer
 * `use(promise)` hook would be cleaner but is canary-only as of React
 * 18.3.x (not exported from the stable bundle). */
type AnnotatedPromise = Promise<string> & { status?: 'fulfilled'; value?: string }

export default function Bio({ promise }: BioProps) {
  const p = promise as AnnotatedPromise
  if (p.status !== 'fulfilled') {
    p.then((v) => { p.status = 'fulfilled'; p.value = v })
    throw p
  }
  return <p data-testid="bio">{p.value}</p>
}
