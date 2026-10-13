const ITEMS = ['a', 'b']
const BOX = { items: ITEMS }
BOX.items.push('c')

export default function Page() {
  return (
    <ul>
      {ITEMS.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  )
}
