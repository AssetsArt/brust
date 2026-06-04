export default function G({ items }: { items: { id: number; num: string; art: string; name: string }[] }) {
  return (
    <ul>
      {items.map((c) => (
        <a x-for key={c.id} href={c.name}>
          <span>{c.num}</span>
          <img src={c.art} alt={c.name} />
          <div>{c.name}</div>
        </a>
      ))}
    </ul>
  )
}
