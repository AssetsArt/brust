import { Dynamic } from '@brust/core'
import type { Node } from './NodeView'

// The same tree through the runtime slot: each root node renders the artifact compiled from StaticNode's source.
export default function SlotTree({ nodes }: { nodes: Node[] }) {
  return (
    <main>
      {nodes.map((n) => (
        <Dynamic key={n.id} component="tree" props={{ n }} />
      ))}
    </main>
  )
}
