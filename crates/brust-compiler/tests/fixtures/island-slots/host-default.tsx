import { useReducer } from 'react'
import type { ReactNode } from 'react'

/** A React component that is the default export of its file: what a route component is. */
export default function Host({ content, children }: { content?: ReactNode; children?: ReactNode }) {
  const [n, hit] = useReducer((c: number) => c + 1, 0)
  return (
    <button type="button" onClick={() => hit()}>
      {n}
      {content}
      {children}
    </button>
  )
}
