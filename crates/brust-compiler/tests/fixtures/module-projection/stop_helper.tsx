import { useState } from 'react'
const ITEMS = [{ id: 1, name: 'a', code: 'C1', meta: { label: 'L1', inner: 'SECRET_M' }, secret: 'SECRET_A' }, { id: 2, name: 'b', code: 'C2', meta: { label: 'L2', inner: 'SECRET_M' }, secret: 'SECRET_B' }]
const first = () => ITEMS[0]
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  return <ul data-s={String(s)}>{ITEMS.map((it) => <li key={it.id} onClick={() => setS(first().id)}>{it.name}</li>)}</ul>
}
