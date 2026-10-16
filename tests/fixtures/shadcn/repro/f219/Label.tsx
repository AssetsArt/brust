// F219: module A. Clean on its own; reads B.
import { LABELS, list } from './labels'
export default function Label() {
  return (
    <p data-testid="p">
      {LABELS.a} {list.join(',')}
    </p>
  )
}
