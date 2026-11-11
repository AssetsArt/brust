import Node from './Node'
import type { Node as N } from './types'

// A wrapper with no state: its rows are a native Node on its own, a static clone at a fixed call site (F524).
export default function Custom({ id, cls, nodes }: { id: string; cls?: string; nodes: N[] }) {
  return (
    <section id={id} className={cls}>
      {nodes.map((n) => (
        <Node key={n.id} n={n} />
      ))}
    </section>
  )
}
