// F511: a store-driven switch of seven arms, each its own element.
import { useStore } from '@brust/core/store/react'
import { sel } from './store'

export function Big() {
  const s = useStore(sel)
  switch (s.active) {
    case 'k0':
      return <p data-testid="big">zero</p>
    case 'k1':
      return <p data-testid="big">one</p>
    case 'k2':
      return <h2 data-testid="big">two</h2>
    case 'k3':
      return <p data-testid="big">three</p>
    case 'k4':
      return <b data-testid="big">four</b>
    case 'k5':
      return <p data-testid="big">five</p>
    default:
      return <i data-testid="big">other</i>
  }
}
