import { type El, ElementView } from './ElementView'

// A non-root component mapping its props to the recursive ElementView.
export function CustomSectionView({ nodes }: { nodes: El[] }) {
  return (
    <div className="custom">
      {nodes.map((n) => (
        <ElementView key={n.id} n={n} />
      ))}
    </div>
  )
}
