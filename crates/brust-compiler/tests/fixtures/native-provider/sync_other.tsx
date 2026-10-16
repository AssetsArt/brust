import { useSyncExternalStore } from 'react'

// not the hydration shape: the snapshots are not `true` / `false`, so a real store: stays React
const subscribe = () => () => {}
export default function P() {
  const v = useSyncExternalStore(subscribe, () => 1, () => 0)
  return <p>{v}</p>
}
