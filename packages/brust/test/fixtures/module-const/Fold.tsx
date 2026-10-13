// L1 G10: Page → Panel → List, rows from a module const (and a relatively imported one).
import { TITLE } from './data'

const ROWS = [
  { id: 1, name: 'one' },
  { id: 2, name: 'two' },
]

function List({ rows }: { rows: { id: number; name: string }[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id}>{r.name}</li>
      ))}
    </ul>
  )
}

function Panel() {
  return (
    <section title={TITLE}>
      <List rows={ROWS} />
    </section>
  )
}

export default function Fold() {
  return (
    <main>
      <Panel />
    </main>
  )
}
