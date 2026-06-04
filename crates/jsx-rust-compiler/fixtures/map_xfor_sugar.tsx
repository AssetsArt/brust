export default function Grid({ items }: { items: { id: number; label: string; href: string }[] }) {
  return (
    <ul>
      {items.map((t) => (
        <a x-for key={t.id} href={t.href} className="tile">
          {t.label}
        </a>
      ))}
    </ul>
  )
}
