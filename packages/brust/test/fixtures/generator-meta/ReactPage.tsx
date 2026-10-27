import { useDeferredValue } from 'react'

// useDeferredValue is outside the native hook set, so this page renders with React (SSR in a worker).
export default function ReactPage() {
  const v = useDeferredValue('react page')
  return (
    <main data-page="react">
      <h1>{v}</h1>
    </main>
  )
}
