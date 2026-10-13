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

export default function Page() {
  return (
    <main>
      <Panel />
    </main>
  )
}
