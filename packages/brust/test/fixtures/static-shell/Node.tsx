import Leaf from './Leaf'
import type { Node as N } from './types'

export default function Node({ n }: { n: N }) {
  switch (n.kind) {
    case 'group':
      return (
        <div data-id={n.id}>
          {(n.children ?? []).map((c) => (
            <Leaf key={c.id} l={c} />
          ))}
        </div>
      )
    case 'img':
      return <img data-id={n.id} src={n.src} alt={n.label} />
    default:
      return <p data-id={n.id}>{n.label}</p>
  }
}
