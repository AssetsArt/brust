// Sub-project J — nested `.map()` native-render coverage. A native: true page
// whose template nests an inner `.map()` (r.cells) inside an outer `.map()`
// (rows). Proves minijinja renders nested `{% for %}` through the SAB pipeline.
export default function NativeNestedMap({
  rows,
}: {
  rows: { id: string; cells: { label: string }[] }[]
}) {
  return (
    <div className="grid">
      {rows.map((r) => (
        <div className="row" key={r.id}>
          {r.cells.map((c) => (
            <span className="cell" key={c.label}>
              {c.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
