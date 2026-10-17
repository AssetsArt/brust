import { useState } from 'react'
const ITEMS = [{ id: 1, name: 'a', code: 'C1', meta: { label: 'L1', inner: 'SECRET_M' }, secret: 'SECRET_A' }, { id: 2, name: 'b', code: 'C2', meta: { label: 'L2', inner: 'SECRET_M' }, secret: 'SECRET_B' }]
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  const rows = ITEMS
  return <ul data-s={String(s)}>{rows.map((it) => <li key={it.id} onClick={() => setS(it.id)}>{it.name}</li>)}</ul>
}
