// ISLAND — the floating "My team" dock + expandable roster panel.
//
// Rendered with `ssr` so the initial team (from the loader) ships in the HTML
// and the dock count is correct on first paint, then hydrates. Stays in sync
// with AddToTeamButton through the shared `teamStore` (one window singleton — see
// ../stores/team.ts).
import { Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { client, useStore } from 'brustjs/client'
import type { Actions } from '../actions'
import type { TeamMember } from '../lib/types'
import { teamStore } from '../stores/team'

const api = client<Actions>()
const MAX = 6

export default function TeamBuilder({ teamInitial }: { teamInitial: TeamMember[] }) {
  // Shared store (GAP S4): in sync with AddToTeamButton via one window singleton.
  const { members } = useStore(teamStore)
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)

  // This island is `ssr`, but the store is empty during SSR. Drive the first
  // render (server + client) from the `teamInitial` prop so the dock count is
  // correct on first paint AND the hydration markup matches; switch to the live
  // store once mounted.
  const team = mounted ? (members ?? []) : (teamInitial ?? [])

  useEffect(() => {
    if (teamInitial?.length) teamStore.members.set(teamInitial)
    setMounted(true)
    api.team
      .get()
      .then((r) => {
        if (r.data) teamStore.members.set(r.data.team)
      })
      .catch(console.error)
  }, [teamInitial])

  async function remove(id: number) {
    const { data } = await api.team({ id }).delete({})
    if (data) teamStore.members.set(data.team)
  }

  const coverage = [...new Set(team.flatMap((m) => m.types))]

  return (
    <div className="fixed bottom-5 right-5 z-[200]">
      {open && (
        <div className="mb-3 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="h-1 bg-brand-500" />
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <Users size={16} className="text-brand-500" />
            <span className="text-sm font-extrabold text-slate-900 dark:text-white">My team</span>
            <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {team.length} / {MAX}
            </span>
          </div>

          {team.length === 0 ? (
            <div className="px-5 py-7 text-center text-xs leading-relaxed text-slate-400">
              <Users size={28} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" />
              No Pokémon on your team yet.
              <br />
              Open a detail page and tap{' '}
              <b className="text-slate-600 dark:text-slate-200">Add to team</b>.
            </div>
          ) : (
            <>
              <div className="max-h-72 overflow-y-auto">
                {team.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-2.5 border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800"
                  >
                    <div className="grid h-9 w-9 flex-none place-items-center rounded-md bg-slate-100 dark:bg-slate-800">
                      <img src={m.artwork} alt={m.displayName} className="h-7 w-7 object-contain" />
                    </div>
                    <a href={`/pokemon/${m.name}`} className="min-w-0 flex-1 no-underline">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">
                        {m.displayName}
                      </div>
                      <div className="font-mono text-[0.625rem] text-slate-400">{m.num}</div>
                    </a>
                    <div className="flex gap-1">
                      {m.types.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                      onClick={() => remove(m.id)}
                      aria-label="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {coverage.length > 0 && (
                <div className="border-t border-slate-100 bg-slate-50 px-3.5 py-3 dark:border-slate-800 dark:bg-slate-800/40">
                  <div className="mb-2 text-[0.625rem] font-bold uppercase tracking-wider text-slate-400">
                    Type coverage
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {coverage.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 transition-colors hover:bg-brand-600"
        onClick={() => setOpen((o) => !o)}
      >
        <Users size={16} />
        My team
        <span className="rounded-full bg-white/25 px-2 py-0.5 text-xs font-extrabold">
          {team.length}
        </span>
      </button>
    </div>
  )
}
