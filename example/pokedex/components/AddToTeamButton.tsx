// ISLAND — the "Add to team / In your team" toggle on the detail page.
//
// Islands run REAL React in the browser (and, when `ssr`, in a Bun worker too),
// so unlike the native page shells they have NO jinja constraints: hooks, inline
// `style={{…}}`, event handlers all work normally.
import { useEffect, useState } from 'react'
import { client } from 'brustjs/client'
import type { Actions } from '../actions'
import type { AddToTeamProps, TeamMember } from '../lib/types'
import { emitTeam, onTeam } from './team-bus'

const api = client<Actions>()

export default function AddToTeamButton(p: AddToTeamProps) {
  const [team, setTeam] = useState<TeamMember[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    api.team.get().then((r) => {
      if (r.data) setTeam(r.data.team)
    })
    return onTeam(setTeam)
  }, [])

  const inTeam = team.some((m) => m.id === p.id)

  async function toggle() {
    setBusy(true)
    try {
      if (inTeam) {
        // NOTE: `.delete({})` — passing an empty body is REQUIRED. A bodyless
        // DELETE from the browser sends no Content-Length, and brust's action
        // dispatch returns 411 on non-GET/HEAD without one. See GAPS S12.
        const { data } = await api.team({ id: p.id }).delete({})
        if (data) emitTeam(data.team)
      } else {
        const { data } = await api.team.post({
          id: p.id,
          name: p.name,
          displayName: p.displayName,
          num: p.num,
          types: p.types,
          artwork: p.artwork,
        })
        if (data?.full) {
          setToast('ทีมเต็มแล้ว · สูงสุด 6 ตัว')
          setTimeout(() => setToast(null), 2200)
        } else if (data) {
          emitTeam(data.team)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className={`aa-btn aa-btn--full${inTeam ? ' aa-btn--secondary' : ''}`}
        style={{ width: '100%' }}
        onClick={toggle}
        disabled={busy}
      >
        {inTeam ? '✓ In your team' : '＋ Add to team'}
      </button>
      {toast && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            right: 0,
            zIndex: 50,
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--danger-50)',
            color: 'var(--danger-700)',
            border: '1px solid rgba(212,28,89,0.25)',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            textAlign: 'center',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}
