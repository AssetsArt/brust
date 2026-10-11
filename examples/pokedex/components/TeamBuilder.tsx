// components/TeamBuilder.tsx — react tier on purpose (useReducer for `open`): SSR + idle hydration (S12). The roster is the
// unified `team` store: the SSR scope is seeded from the snapshot, so the first client snapshot equals the server paint (D8).
import { useStore } from '@brust/core/store/react'
import { useReducer } from 'react'
import { removeMember } from '../lib/team-client'
import { team } from '../stores/team'

const flip = (open: boolean): boolean => !open

export default function TeamBuilder() {
  const { members, max } = useStore(team)
  const [open, toggle] = useReducer(flip, false)
  return (
    <div className="fixed bottom-5 right-5 z-[200]">
      {open && (
        <div data-testid="team-panel" className="mb-3 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800"><span className="text-sm font-extrabold">My team</span><span className="ml-auto text-xs font-semibold">{members.length} / {max}</span></div>
          {members.length === 0 ? <div className="px-5 py-7 text-center text-xs text-slate-400">No Pokémon on your team yet.</div> : members.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
              <img src={m.artwork} alt={m.displayName} className="h-7 w-7 object-contain" />
              <a href={`/pokemon/${m.name}`} className="min-w-0 flex-1 text-xs font-semibold no-underline">{m.displayName}</a>
              <button type="button" aria-label="Remove" onClick={() => removeMember(m.id)} className="rounded p-1 text-slate-400">×</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={() => toggle()} className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
        My team <span data-testid="team-count" className="rounded-full bg-white/25 px-2 py-0.5 text-xs font-extrabold">{members.length}</span>
      </button>
    </div>
  )
}
