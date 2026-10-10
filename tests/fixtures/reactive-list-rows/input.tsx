import { useState } from 'react'
// A props-sourced keyed list whose rows carry a handler: the row can be re-bound when the props
// change, so the host seeds `rows` — projected to the fields the client reads (id, name), never
// `secret` (ledger F71).
export default function Picker(props: { rows: { id: string; name: string; secret: string }[] }) {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <ul>
      {props.rows.map((r) => (
        <li key={r.id} className={r.id === picked ? 'on' : ''} onClick={() => setPicked(r.id)}>{r.name}</li>
      ))}
    </ul>
  )
}
