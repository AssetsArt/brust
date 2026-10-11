export default function TypesPage({ types }: { types: { name: string; label: string; tint: string }[] }) {
  return (
    <>
      <h1>Types</h1>
      <ul>{types.map((t) => <li key={t.name}><span data-type={t.name} style={{ background: t.tint }}>{t.label}</span></li>)}</ul>
    </>
  )
}
