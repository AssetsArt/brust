const ITEMS = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta' },
]

export default function Page() {
  return (
    <ul>
      {ITEMS.map((it) => (
        <li key={it.id}>{it.title}</li>
      ))}
    </ul>
  )
}
