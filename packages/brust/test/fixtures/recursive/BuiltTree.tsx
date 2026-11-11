import type { Node } from './NodeView'
import StaticNode from './StaticNode'

export default function BuiltTree({ nodes }: { nodes: Node[] }) {
  return (
    <main>
      {nodes.map((n) => (
        <StaticNode key={n.id} n={n} />
      ))}
    </main>
  )
}
