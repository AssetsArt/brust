// R1.4: the inlined child's job is a real one (a call), so the server must still run it.
const ROWS = ['b', 'a', 'c'].slice().sort()

function List({ rows }: { rows: string[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  )
}

function Panel() {
  return (
    <section>
      <List rows={ROWS} />
    </section>
  )
}

export default function Job() {
  return (
    <main>
      <Panel />
    </main>
  )
}
