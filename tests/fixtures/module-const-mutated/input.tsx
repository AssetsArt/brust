const ITEMS = ['a', 'b']
ITEMS.push('c')

export default function Page() {
  return (
    <ul>
      {ITEMS.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  )
}
