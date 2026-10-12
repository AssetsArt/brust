import { useState } from 'react'

// F96b: a handler/helper that spreads a state array. The chunk printed `[...items, 4]` with the
// signal itself (`items`, not `items()`), so the click threw "items is not iterable".
export default function F96HelperSpread() {
  const [items, setItems] = useState([1, 2, 3])
  const add = () => setItems([...items, items.length + 1])
  const sorted = () => [...items].sort((a, b) => b - a)
  return (
    <div>
      <button onClick={add}>add</button>
      <p id="n">{items.length}</p>
      <p id="top">{sorted()[0]}</p>
    </div>
  )
}
