export default function Widget({ items }: { items: { id: number; label: string }[] }) {
  return (
    <section x-data="w" x-props={items}>
      <a href={items}>x</a>
    </section>
  )
}
