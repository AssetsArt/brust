// Demo, native tier: reads the `team` store in render. The server paints the count from the page's store
// snapshot; in the browser it follows every write to the store, wherever it comes from.
import { useStore } from '@brust/core/store/react'
import { team } from './team-store'

export default function TeamBadge() {
  const s = useStore(team)
  return (
    <p className="team-badge">
      <span className="tier native">native</span> Team <b>{s.members.length}</b> / {s.max}
    </p>
  )
}
