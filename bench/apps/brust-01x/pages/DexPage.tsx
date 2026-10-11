type Badge = { name: string; label: string; tint: string }
export default function DexPage({ rows, count }: { rows: { id: number; num: string; displayName: string; badges: Badge[] }[]; count: number }) {
  return (
    <>
      <h1>Pokédex</h1>
      <p>{count} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.badges.map((b) => <span key={b.name} data-type={b.name} style={{ background: b.tint }}>{b.label}</span>)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
