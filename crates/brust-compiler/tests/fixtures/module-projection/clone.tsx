import { useState } from 'react'
import RBox from './RBox'
const ITEMS = [{ id: 1, name: 'a', code: 'C1', meta: { label: 'L1', inner: 'SECRET_M' }, secret: 'SECRET_A' }, { id: 2, name: 'b', code: 'C2', meta: { label: 'L2', inner: 'SECRET_M' }, secret: 'SECRET_B' }]
export default function Page() {
  const [s, setS] = useState<unknown>(0)
  return <main><button type="button" onClick={() => setS(!s)}>f</button>{ITEMS.map((it) => <section key={it.id}><RBox id={'b' + it.id}><b data-v={s ? 1 : 0}>r</b></RBox></section>)}</main>
}
