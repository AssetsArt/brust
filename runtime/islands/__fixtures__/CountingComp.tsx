// Test fixture: an SSR component that bumps the shared renderCounter on every
// server render, so the component-ISR integration test can prove a cache HIT
// skipped the factory render. Reuses the island fixture's render-counter
// singleton (Bun module cache → same object across imports).
import { createElement } from 'react'
import { renderCounter } from './render-counter.ts'

export default ({ n }: { n: number }) => {
  renderCounter.count++
  return createElement('span', null, String(n))
}
