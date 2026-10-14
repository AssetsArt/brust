import { useReducer } from 'react'
import type { ReactNode } from 'react'

/** React (a reducer): `content` is an element prop (always shown), `children` appear when open. */
export function Tip({ label, content, children }: { label: string; content?: ReactNode; children?: ReactNode }) {
  // useReducer keeps Tip a React island (useState + a handler would make it native).
  const [open, toggle] = useReducer((o: boolean) => !o, false)
  return (
    <div data-testid={`tip-${label}`} data-state={open ? 'open' : 'closed'}>
      <button type="button" onClick={() => toggle()}>
        {label}
      </button>
      <span data-testid={`content-${label}`}>{content}</span>
      {open ? <div data-testid={`body-${label}`}>{children}</div> : null}
    </div>
  )
}

/** Static. */
export function Badge({ text, tone }: { text: string; tone?: string }) {
  return <em className={`badge ${tone ?? 'plain'}`}>{text}</em>
}
