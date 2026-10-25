import { useStore } from '@brust/core/store/react'
import { nav } from './nav'

export default function Page() {
  const s = useStore(nav)
  return <p>{s.open ? 'open' : 'closed'}</p>
}
