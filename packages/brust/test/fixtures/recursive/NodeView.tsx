import Leaf from './Leaf'

export type Node = { id: string; kind: 'group' | 'text'; label: string; children?: Node[] }

// Renders itself: one template macro, not a React island per node.
export function NodeView({ n }: { n: Node }) {
  switch (n.kind) {
    case 'group':
      return (
        <section data-id={n.id}>
          <Leaf label={n.label} />
          <div>
            {(n.children ?? []).map((c) => (
              <NodeView key={c.id} n={c} />
            ))}
          </div>
        </section>
      )
    default:
      return <p data-id={n.id}>{n.label}</p>
  }
}
