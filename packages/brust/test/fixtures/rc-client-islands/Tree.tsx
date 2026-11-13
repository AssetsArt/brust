import Leaf from './Leaf'

type N = { id: string; label: string; kids?: N[] }

// Renders itself for a group, a React leaf island for an item: the tree is a template macro, the leaf client-only.
export default function Tree({ nodes }: { nodes: N[] }) {
  return (
    <ul>
      {nodes.map((n) => (
        <li key={n.id} data-node={n.id}>
          {n.kids ? <Tree nodes={n.kids} /> : <Leaf label={n.label} />}
        </li>
      ))}
    </ul>
  )
}
