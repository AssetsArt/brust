import { useState } from 'react'
import { LRoot, LThumb } from './LiveRest'
// PR3 D2: a row value reaches LRoot's rest, which LRoot reads where it would not follow a change; the list is state, so a
// row the client adds would keep the first row's value.
export default function P() {
  const [items, setItems] = useState([1, 2])
  return (
    <main>
      <button type="button" onClick={() => setItems((xs) => [...xs, xs.length + 1])}>add</button>
      {items.map((i) => (
        <LRoot key={i} data-testid={`b${i}`}>
          <LThumb />
        </LRoot>
      ))}
    </main>
  )
}
