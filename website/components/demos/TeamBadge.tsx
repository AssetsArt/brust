// Demo, native tier: reads the `team` store in render. The page is painted with an empty team (a static export has
// no reader's data); in the browser the store is filled from localStorage and the badge follows every write to it.
import { useStore } from '@brust/core/store/react'
import { useEffect, useRef } from 'react'
import { loadTeam } from './team-client'
import { team } from './team-store'

export default function TeamBadge() {
  const root = useRef<HTMLSpanElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    loadTeam()
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const s = useStore(team)
  return (
    <p className="team-badge text-[1.1rem]">
      <span className="inline-flex items-center gap-[.35rem] font-mono text-[12px] text-t-native before:size-2 before:rounded-xs before:bg-t-native before:content-['']" ref={root}>
        native
      </span> Team <b className="font-display text-[1.6rem] font-normal">{s.members.length}</b> / {s.max}
    </p>
  )
}
