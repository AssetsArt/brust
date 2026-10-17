// F362: a module list the rows run over; `secret` is never read by the client.
import { useState } from 'react'
import RBox from './RBox'
const ITEMS = [
  { id: 1, name: 'one', secret: 'SECRET_A' },
  { id: 2, name: 'two', secret: 'SECRET_B' },
  { id: 3, name: 'three', secret: 'SECRET_C' },
]
export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" data-testid="f" onClick={() => setOn(!on)}>f</button>
      {ITEMS.map((it) => (
        <section key={it.id}>
          <RBox id={`b${it.id}`}>
            <b data-v={on ? 1 : 0}>r</b>
          </RBox>
        </section>
      ))}
    </main>
  )
}
