import { useState } from 'react'
import { fmt } from './money'

export default function Card(props: { show: boolean; n: number; items: { id: string; sale: boolean; price: number }[]; a: boolean; b: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      {props.show && <b className="p">{fmt(props.n)}</b>}
      <button onClick={() => setOpen(!open)}>toggle</button>
      {open && <i className="s">{fmt(props.n * 2)}</i>}
      <ul>{props.items.map((it) => <li key={it.id}>{it.sale && <em>{fmt(it.price)}</em>}</li>)}</ul>
      {props.a && props.b && <u>{fmt(props.n + 1)}</u>}
    </div>
  )
}
