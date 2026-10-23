import { useReducer, useTransition } from 'react'

// useReducer keeps this a React island (hook-unsupported). `shown` false paints only a display:none child, so the
// island contributes no box of its own: the flex gap around it must not count the wrapper.
export default function Gate({ shown }: { shown: boolean }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" data-testid="gate" style={{ display: shown ? 'inline-block' : 'none' }} onClick={() => bump()}>
      gate {n}
    </button>
  )
}
