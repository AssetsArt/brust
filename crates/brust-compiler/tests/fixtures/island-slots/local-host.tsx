import { useReducer, useTransition } from 'react'
import type { ReactNode } from 'react'

// A same-file React component is not a route component even when this file is one.
function Box({ children }: { children?: ReactNode }) {
  useTransition()
  const [n, hit] = useReducer((c: number) => c + 1, 0)
  return <button onClick={() => hit()}>{n}{children}</button>
}

export default function Page() {
  return (
    <Box>
      <b>hi</b>
    </Box>
  )
}
