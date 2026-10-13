type Item = { id: string; title: string; href?: string; hidden?: boolean }

export default function Menu({ items }: { items: Item[] }) {
  return (
    <nav>
      <ul>
        {items.map((it) =>
          it.href ? (
            <li key={it.id}>
              <a href={it.href}>{it.title}</a>
            </li>
          ) : (
            <li key={it.id}>
              <h4>{it.title}</h4>
            </li>
          ),
        )}
      </ul>
      <ol>
        {items.map((it) => it.hidden && <li key={it.id}>{it.title}</li>)}
      </ol>
      <p>
        {items.map((it) => (it.href ? <a key={it.id} href={it.href}>{it.title}</a> : <h4 key={'h' + it.id}>{it.title}</h4>))}
      </p>
    </nav>
  )
}
