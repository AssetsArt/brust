// Demo, native tier: each button runs the Actions page's `POST /team` rules in the browser (team-client.ts; this site
// is a static export); the result goes into the `team` store, and the buttons repaint from the store. The seventh
// Pokémon gets a 409.
import { useStore } from '@brust/core/store/react'
import { useEffect, useRef, useState } from 'react'
import { addMember, loadTeam } from './team-client'
import { team } from './team-store'

export default function TeamPicker({ candidates }: { candidates: { id: number; name: string; sprite: string }[] }) {
  const root = useRef<HTMLUListElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    loadTeam()
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const s = useStore(team)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="picker grid min-w-0 gap-3">
      <ul className="m-0 grid list-none grid-cols-2 gap-x-[.9rem] gap-y-[.35rem] pl-[1.2rem] text-[14.5px] max-narrow:grid-cols-1" ref={root}>
        {candidates.map((c) => (
          <li key={c.id} className="motion-safe:animate-[rise_.2s_ease-out_both] my-[.3rem] flex max-w-[68ch] min-w-0 items-center gap-2">
            <img src={c.sprite} alt="" width={40} height={40} loading="lazy" className="size-10 flex-none [image-rendering:pixelated]" />
            <button
              type="button"
              className="cursor-pointer rounded-xs border border-ink bg-paper px-[.7rem] py-[.35rem] text-ink tabular-nums [font-family:inherit] [line-height:inherit] text-[14px] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97] disabled:cursor-default disabled:opacity-60"
              disabled={busy || s.members.some((m) => m.id === c.id)}
              onClick={async () => {
                setBusy(true)
                try {
                  setStatus((await addMember(c.id)) || `200 · added ${c.name}`)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {s.members.some((m) => m.id === c.id) ? `${c.name} ✓` : `Add ${c.name}`}
            </button>
          </li>
        ))}
      </ul>
      <p className="vp-note max-w-[68ch] text-[13.5px] text-ink-2" aria-live="polite">
        {status === '' ? `Team ${s.members.length} / ${s.max}. Add a seventh to see the 409.` : `${status} · team ${s.members.length} / ${s.max}`}
      </p>
    </div>
  )
}
