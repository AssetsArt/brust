// Test fixture for native-render T9 contained-failure: a valid default-exported
// component that THROWS during render. This exercises the renderToString failure
// path (the production-realistic SSR failure), not just the
// `typeof Component !== 'function'` guard.
import type { createElement } from 'react'

export default function ThrowingIsland(): ReturnType<typeof createElement> {
  throw new Error('boom in render')
}
