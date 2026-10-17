import { useState } from 'react'

// F349: slot content in a row of a module-level list that spreads a PROP PATH onto its host (`<b {...props.attrs}>`).
// Spread is not a row directive, so the row is never re-created and the child's `RowOnly` link would drop: the F309
// guard (which runs before that is known) over-refuses it today. Pinned as it is; admitting it needs the refusal deferred
// to `resolve_row_only` (task challenge on ledger-guetta-10).
function Card({ children, id }: { children?: React.ReactNode; id: string }) {
  return <li data-card={id}>{children}</li>
}

const items = [{ id: 'a', n: 'A' }, { id: 'b', n: 'B' }]

export default function Page(props: { attrs: Record<string, string> }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <button type="button" onClick={() => setN(n + 1)}>{n}</button>
      <ul>
        {items.map((it) => (
          <Card key={it.id} id={it.id}>
            <b {...props.attrs}>{it.n}</b>
          </Card>
        ))}
      </ul>
    </main>
  )
}
