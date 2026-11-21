import { useReducer, useTransition } from 'react'
import type { ReactNode } from 'react'

// Case 6: React (a reducer keeps it an island); what it draws is React's.
export default function Frame({ children }: { children?: ReactNode }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <div id="frame">
      <button type="button" id="frame-btn" onClick={() => bump()}>
        frame {n}
      </button>
      {children}
    </div>
  )
}
