import { useState } from 'react'
const ITEMS = [{ id: 1, slug: 'k1', name: 'a', secret: 'SECRET_A' }, { id: 2, slug: 'k2', name: 'b', secret: 'SECRET_B' }]
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  return <ul data-s={String(s)}>{ITEMS.map((it) => <li key={it.slug} onClick={() => setS(it.id)}>{it.name}</li>)}</ul>
}
