import { useState } from 'react'

// F310: a static child linked only by what a ROW of a module-level list gives it (a `RowOnly` link). The slot content is
// the caller's.
function Card({ children, id }: { children?: React.ReactNode; id: string }) {
  return <li data-card={id}>{children}</li>
}

const items = [{ id: 'a', n: 'A' }, { id: 'b', n: 'B' }]

export default function Page() {
  const [n, setN] = useState(0)
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" onClick={() => setOn(!on)}>{n}</button>
      <ul>
        {items.map((it) => (
          <Card key={it.id} id={it.id}>
            <button type="button" onClick={() => setN(n + 1)}>{it.n}</button>
          </Card>
        ))}
      </ul>
    </main>
  )
}
