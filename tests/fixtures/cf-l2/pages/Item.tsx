export default function Item({ item }: { item: { id: string; r: number } }) {
  return (
    <article>
      <h1>item {item.id}</h1>
      <p className="r">{item.r}</p>
    </article>
  )
}
