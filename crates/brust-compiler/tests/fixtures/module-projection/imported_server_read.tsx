import { useState } from 'react'
import { ITEMS } from './data'
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  return <ul data-s={String(s)}>{ITEMS.map((it) => <li key={it.id} onClick={() => setS(it.id)}>{it.name}</li>)}</ul>
}
