import { Suspense, createElement } from 'react'

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
  // React 18 SSR Suspense: throw a Promise to suspend the renderer until it resolves.
  if ((promise as any).status !== 'fulfilled') {
    promise.then((v) => { (promise as any).status = 'fulfilled'; (promise as any).value = v })
    throw promise
  }
  return createElement('p', { 'data-testid': 'slow-content' }, (promise as any).value)
}

export default function SlowSuspense(): JSX.Element {
  return createElement('html', null,
    createElement('head', null, createElement('title', null, 'slow-suspense')),
    createElement('body', null,
      createElement('h1', null, 'Streaming demo'),
      createElement(Suspense, { fallback: createElement('p', { 'data-testid': 'spinner' }, 'loading...') },
        createElement(SlowChild),
      ),
    ),
  )
}
