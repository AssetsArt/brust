import Tree from './Tree'

// The outer component that enters the recursive tree.
export default function Menu({ nodes }: { nodes: { id: string; label: string; kids?: unknown[] }[] }) {
  return (
    <nav>
      <h1>menu</h1>
      <Tree nodes={nodes as never} />
    </nav>
  )
}
