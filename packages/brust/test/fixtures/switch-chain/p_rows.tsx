import { useState } from 'react'
import { KRoot, KThumb } from './Kit'
// switch-provider-chain PR3 D2: switches with a Thumb carried in the rest, in list rows whose items come from state.
export default function Page() {
  const [items, setItems] = useState([1, 2])
  return (
    <main>
      <button type="button" data-testid="add" onClick={() => setItems((xs) => [...xs, xs.length ? Math.max(...xs) + 1 : 1])}>add</button>
      <button type="button" data-testid="rm" onClick={() => setItems((xs) => xs.slice(1))}>rm</button>
      {items.map((i) => (
        <section key={i} data-row={i}>
          <KRoot data-testid={`b${i}`}>
            <KThumb />
          </KRoot>
        </section>
      ))}
    </main>
  )
}
