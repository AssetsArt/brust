const LINKS = [
  { href: '/about', label: 'About' },
  { href: '/count', label: 'Counter' },
]

export default function Home() {
  return (
    <main>
      <h1 className="title">Idle workers</h1>
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href}>{l.label}</a>
          </li>
        ))}
      </ul>
    </main>
  )
}
