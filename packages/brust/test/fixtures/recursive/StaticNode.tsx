// The built twin of `rcSource.ts` (same text, no imports so it compiles at any virtual path): a component that renders itself, static, one template macro.
type N = { id: string; kind: string; label: string; children?: N[] }

export default function StaticNode({ n }: { n: N }) {
  if (n.kind === 'group')
    return (
      <section data-id={n.id}>
        <h2>{n.label}</h2>
        <div>
          {(n.children ?? []).map((c) => (
            <StaticNode key={c.id} n={c} />
          ))}
        </div>
      </section>
    )
  return <p data-id={n.id}>{n.label}</p>
}
