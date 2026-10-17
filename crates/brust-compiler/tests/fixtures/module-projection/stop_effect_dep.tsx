import { useEffect, useState } from 'react'
const ITEMS = [{ id: 1, name: 'a', secret: 'SECRET_A' }, { id: 2, name: 'b', secret: 'SECRET_B' }]
export default function P() {
  const [s, setS] = useState(0)
  const s0 = ITEMS[0]?.secret
  useEffect(() => { document.title = String(s) }, [s, s0])
  return <ul data-s={s}>{ITEMS.map((it) => <li key={it.id} onClick={() => setS(it.id)}>{it.name}</li>)}</ul>
}
