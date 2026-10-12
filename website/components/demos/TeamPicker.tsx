// Demo, native tier: each button calls the real `POST /team` action (website/actions.ts) through the typed client;
// the reply goes into the `team` store, and the buttons repaint from the store. The seventh Pokémon gets a 409.
import { useStore } from '@brust/core/store/react'
import { useState } from 'react'
import { addMember } from './team-client'
import { team } from './team-store'

export default function TeamPicker({ candidates }: { candidates: { id: number; name: string; sprite: string }[] }) {
  const s = useStore(team)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="picker">
      <ul className="demo-list">
        {candidates.map((c) => (
          <li key={c.id}>
            <img src={c.sprite} alt="" width={40} height={40} loading="lazy" />
            <button
              type="button"
              className="demo-btn"
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
      <p className="vp-note" aria-live="polite">
        {status === '' ? `Team ${s.members.length} / ${s.max}. Add a seventh to see the 409.` : `${status} · team ${s.members.length} / ${s.max}`}
      </p>
    </div>
  )
}
