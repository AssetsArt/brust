import { useState } from 'react'
import Tag from './Tag'
const ITEMS = [{ id: 1, name: 'a', code: 'C1', meta: { label: 'L1', inner: 'SECRET_M' }, secret: 'SECRET_A' }, { id: 2, name: 'b', code: 'C2', meta: { label: 'L2', inner: 'SECRET_M' }, secret: 'SECRET_B' }]
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  return <main><button type="button" onClick={() => setS(!s)}>f</button>{ITEMS.map((it) => <Tag key={it.id} id={it as never} on={!!s} />)}</main>
}
