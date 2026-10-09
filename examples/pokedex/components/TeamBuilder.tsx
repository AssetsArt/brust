// components/TeamBuilder.tsx — react tier on purpose (useReducer): SSR + idle hydration (S12). Roster is local state.
import { useReducer } from 'react'
import type { TeamMember } from '../lib/types'
type Action = { type: 'toggle' } | { type: 'remove'; id: number }
type State = { open: boolean; team: TeamMember[] }
const MAX = 6
function reducer(s: State, a: Action): State {
  if (a.type === 'toggle') return { ...s, open: !s.open }
  return { ...s, team: s.team.filter((m) => m.id !== a.id) }
}
export default function TeamBuilder(props: { teamInitial: TeamMember[] }) {
  const [s, dispatch] = useReducer(reducer, { open: false, team: props.teamInitial })
  return (
    <div className="fixed bottom-5 right-5 z-[200]">
      {s.open && (
        <div data-testid="team-panel" className="mb-3 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800"><span className="text-sm font-extrabold">My team</span><span className="ml-auto text-xs font-semibold">{s.team.length} / {MAX}</span></div>
          {s.team.length === 0 ? <div className="px-5 py-7 text-center text-xs text-slate-400">No Pokémon on your team yet.</div> : s.team.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
              <img src={m.artwork} alt={m.displayName} className="h-7 w-7 object-contain" />
              <a href={`/pokemon/${m.name}`} className="min-w-0 flex-1 text-xs font-semibold no-underline">{m.displayName}</a>
              <button type="button" aria-label="Remove" onClick={() => dispatch({ type: 'remove', id: m.id })} className="rounded p-1 text-slate-400">×</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={() => dispatch({ type: 'toggle' })} className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
        My team <span data-testid="team-count" className="rounded-full bg-white/25 px-2 py-0.5 text-xs font-extrabold">{s.team.length}</span>
      </button>
    </div>
  )
}
