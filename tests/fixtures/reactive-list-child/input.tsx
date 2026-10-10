import { useState } from 'react'
import Badge from './Badge'
import { take } from './take'
type Badge = { type: string; label: string; color: string }
type Row = { id: number; num: string; badges: Badge[] }
// A state-dependent list (module helper, like the pokedex DexFilter): the client re-creates rows,
// so the static child in the row keeps its link, and `rows` is read whole by the helper, so its
// x-props seed stays the full list (ledger F71 fallback).
export default function Dex(props: { rows: Row[] }) {
  const [n, setN] = useState(1)
  const shown = take(props.rows, n)
  return (
    <section>
      <button onClick={() => setN(n + 1)}>more</button>
      <ul>{shown.map((p) => <li key={p.id}>{p.num}{p.badges.map((b) => <Badge key={b.type} type={b.type} label={b.label} color={b.color} />)}</li>)}</ul>
    </section>
  )
}
