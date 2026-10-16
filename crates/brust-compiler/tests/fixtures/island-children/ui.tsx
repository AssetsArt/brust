import { useReducer, useTransition } from 'react'

// useReducer keeps Card a React island; the others are what a page puts inside it.
export function Card({ title, children }: { title?: string; children?: React.ReactNode }) {
  useTransition()
  const [n, hit] = useReducer((x: number) => x + 1, 0)
  return (
    <section data-testid="card">
      <h2>{title}</h2>
      <button type="button" onClick={() => hit()}>
        {n}
      </button>
      {children}
    </section>
  )
}

/** Static: no state, no handler. */
export function Badge({ n, tone }: { n: number; tone?: string }) {
  return <span className={`badge ${tone ?? 'plain'}`}>{n}</span>
}

function Hidden({ label }: { label: string }) {
  return <i>{label}</i>
}

export function Wrap({ label }: { label: string }) {
  return <Hidden label={label} />
}
