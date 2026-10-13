import Search from './Search'

// A static row wrapper rendered per item of the page's list: its island renders per row.
export default function Row({ item }: { item: { id: string; name: string } }) {
  return (
    <li>
      <Search label={item.name} />
    </li>
  )
}
