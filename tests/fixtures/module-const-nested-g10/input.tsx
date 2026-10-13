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
