const ITEMS = ['a', 'b']
ITEMS.length = 1

export default function Page() {
  return (
    <ul>
      {ITEMS.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  )
}
