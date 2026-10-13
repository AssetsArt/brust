const ITEMS = [{ id: 'a', done: false }]
for (const it of ITEMS) it.done = true

export default function Page() {
  return (
    <ul>
      {ITEMS.map((it) => (
        <li key={it.id}>{String(it.done)}</li>
      ))}
    </ul>
  )
}
