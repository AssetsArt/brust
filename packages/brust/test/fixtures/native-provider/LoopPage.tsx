import { useState } from 'react'

// props named like the server template's own names (`loop`, `range`): the template reads them off the props object
function Row({ loop, range, items }: { loop: string; range: string; items: string[] }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i}>
          {i}:{loop}:{range}
        </li>
      ))}
    </ul>
  )
}

function Counter({ loop }: { loop: number }) {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + loop)}>
      {n}
    </button>
  )
}

// `loop` is also the route's own param: the page component is standalone, so its `loop` is read through `_props`
export default function LoopPage({ loop }: { loop?: string }) {
  return (
    <main>
      <p>page:{loop}</p>
      <ol>
        {['x', 'y'].map((i) => (
          <li key={i}>
            {i}-{loop}
          </li>
        ))}
      </ol>
      <Row loop="L" range="R" items={['a', 'b']} />
      <Counter loop={2} />
    </main>
  )
}
