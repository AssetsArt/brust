// Demo, native tier: reads the `team` store in render. The server paints the count from the page's store
// snapshot; in the browser it follows every write to the store, wherever it comes from.
import { useStore } from '@brust/core/store/react'
import { useEffect, useRef } from 'react'
import { team } from './team-store'

export default function TeamBadge() {
  const root = useRef<HTMLSpanElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const s = useStore(team)
  return (
    <p className="team-badge">
      <span className="tier native" ref={root}>
        native
      </span> Team <b>{s.members.length}</b> / {s.max}
    </p>
  )
}
