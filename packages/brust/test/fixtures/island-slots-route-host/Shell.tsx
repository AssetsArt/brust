import { useReducer } from 'react'
import type { ReactNode } from 'react'

/** A route component (React: a reducer) that another page also uses with JSX children. */
export default function Shell({ title, data, children }: { title: string; data?: unknown; children?: ReactNode }) {
  const [open, toggle] = useReducer((o: boolean) => !o, false)
  return (
    <main>
      <button type="button" onClick={() => toggle()}>
        {title}
      </button>
      <pre data-testid="data">{JSON.stringify(data)}</pre>
      {open ? <div>{children}</div> : null}
    </main>
  )
}
