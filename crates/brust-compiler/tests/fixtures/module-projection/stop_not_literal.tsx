import { useState } from 'react'
const S = 'SECRET_A'
const ITEMS = [{ id: 1, name: 'a', secret: S }, { id: 2, name: 'b', secret: 'SECRET_B' }]
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  return <ul data-s={String(s)}>{ITEMS.map((it) => <li key={it.id} onClick={() => setS(it.id)}>{it.name}</li>)}</ul>
}
