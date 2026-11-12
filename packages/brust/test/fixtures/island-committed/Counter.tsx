import { useId, useState, useTransition } from 'react'

// A React island (useTransition keeps it on the React tier), hydrated with hydrateRoot: a click handler and two useId ids the server and the client must agree on.
export default function Counter({ start }: { start: number }) {
  useTransition()
  const [n, setN] = useState(start)
  const field = useId()
  const hint = useId()
  return (
    <div>
      <label htmlFor={field}>count</label>
      <input id={field} aria-describedby={hint} readOnly value={n} />
      <span id={hint} data-testid="ids">{`${field}|${hint}`}</span>
      <button type="button" data-testid="inc" onClick={() => setN((v) => v + 1)}>
        inc
      </button>
      <output data-testid="n">{n}</output>
    </div>
  )
}
