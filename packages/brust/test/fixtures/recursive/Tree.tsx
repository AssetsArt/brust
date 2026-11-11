import { type Node, NodeView } from './NodeView'

export default function Tree({ nodes }: { nodes: Node[] }) {
  return (
    <main>
      {nodes.map((n) => (
        <NodeView key={n.id} n={n} />
      ))}
    </main>
  )
}
