export default function ListNav({ items }: { items: { href: string; label: string }[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li><a href={item.href}>{item.label}</a></li>
      ))}
    </ul>
  )
}
