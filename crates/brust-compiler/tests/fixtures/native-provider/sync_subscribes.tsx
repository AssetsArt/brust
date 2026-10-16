import { useSyncExternalStore } from 'react'

// the snapshots are the hydration pair but `subscribe` subscribes to something: not the shape
function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  return () => window.removeEventListener('online', cb)
}
export default function P() {
  const v = useSyncExternalStore(subscribe, () => true, () => false)
  return <p>{v ? 'y' : 'n'}</p>
}
