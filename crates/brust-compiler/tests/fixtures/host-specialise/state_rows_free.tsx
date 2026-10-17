import { useState } from 'react'
import RBox from './RBox'
// F344 (1): a host in list rows whose items come from state; the content reads page state only; the host's own id is a row value .
export default function Page() {
  const [on, setOn] = useState(false)
  const [items, setItems] = useState([1, 2])
  return (
    <main>
      <button type="button" onClick={() => setOn(!on)}>f</button>
      <button type="button" onClick={() => setItems((xs) => [...xs, xs.length + 1])}>add</button>
      {items.map((i) => (
        <section key={i}>
          <RBox id={`b${i}`}>
            <b data-v={on ? 1 : 0}>r</b>
          </RBox>
        </section>
      ))}
    </main>
  )
}
