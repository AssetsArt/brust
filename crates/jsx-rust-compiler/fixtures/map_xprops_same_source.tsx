export default function G({ items }: { items: { id: number; label: string }[] }) {
  return (
    <section x-data="g" x-props={items}>
      {items.map((c) => (
        <a x-for key={c.id} href={c.label}>
          {c.label}
        </a>
      ))}
    </section>
  )
}
