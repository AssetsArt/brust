// L1 G10: Page → Panel → List, rows from a module const (and a relatively imported one).
import { ROWS, TITLE } from './data'

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
