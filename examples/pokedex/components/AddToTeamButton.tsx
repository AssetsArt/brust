// components/AddToTeamButton.tsx — NATIVE (M3-F D7). Render reads the team store through useStore: the server paints
// __store.team.*, the chunk reads team.members() live. Writes go through lib/team-client (handlers only, compiler rule
// store-write-in-render).
import { useStore } from '@brust/core/store/react'
import { useState } from 'react'
import { toggleMember } from '../lib/team-client'
import { team } from '../stores/team'

export default function AddToTeamButton({ id }: { id: number }) {
  const s = useStore(team)
  const [busy, setBusy] = useState(false)
  const inTeam = s.members.some((m) => m.id === id)
  const full = !inTeam && s.members.length >= s.max
  return (
    <button
      type="button"
      data-testid="add-to-team"
      data-in-team={inTeam ? 'true' : 'false'}
      disabled={busy || full}
      className={
        inTeam
          ? 'inline-flex w-full items-center justify-center rounded-lg bg-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors disabled:opacity-50 dark:bg-slate-700 dark:text-slate-100'
          : 'inline-flex w-full items-center justify-center rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50'
      }
      onClick={async () => {
        setBusy(true)
        try {
          await toggleMember(id, inTeam)
        } finally {
          setBusy(false)
        }
      }}
    >
      {inTeam ? 'In your team' : full ? 'Team Full' : 'Add to team'}
    </button>
  )
}
