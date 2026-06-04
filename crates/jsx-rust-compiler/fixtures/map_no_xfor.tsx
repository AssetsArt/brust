export default function Grid2({ items }: { items: { id: number; label: string; href: string }[] }) {
  return (
    <ul>
      {items.map((t) => (
        <a href={t.href} className="tile">
          {t.label}
        </a>
      ))}
    </ul>
  )
}
