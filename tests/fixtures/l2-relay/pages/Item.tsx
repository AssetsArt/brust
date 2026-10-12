export default function Item({ item }: { item: { id: string; n: number } }) {
  return (
    <article>
      <h1>item {item.id}</h1>
      <p className="n">{item.n}</p>
    </article>
  )
}
