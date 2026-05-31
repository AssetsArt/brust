// Test fixture: an SSR island that bumps a shared counter on every render, so
// the ISR integration test can prove a cache HIT skipped renderToString. Markup
// embeds `n` (same shape as StubIsland) so the served html is assertable.
import { createElement } from 'react'
import { renderCounter } from './render-counter.ts'

export default ({ n }: { n: number }) => {
  renderCounter.count++
  return createElement('span', null, String(n))
}
