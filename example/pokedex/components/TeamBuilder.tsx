// ISLAND — the floating "My team" dock + expandable roster panel.
//
// Rendered with `ssr` so the initial team (from the loader) ships in the HTML
// and the dock count is correct on first paint, then hydrates. Stays in sync
// with AddToTeamButton through the window-event bus (see team-bus.ts / GAPS S4).
import { useEffect, useState } from 'react'
import { client } from '../../../runtime/client/index.ts'
import type { Actions } from '../actions'
import type { TeamMember } from '../lib/types'
import { emitTeam, onTeam } from './team-bus'

const api = client<Actions>()
const MAX = 6

export default function TeamBuilder({ teamInitial }: { teamInitial: TeamMember[] }) {
  const [team, setTeam] = useState<TeamMember[]>(teamInitial ?? [])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Re-sync from the server on mount (the SSR snapshot may be stale by now),
    // then subscribe to mutations from the other island.
    api.team.get().then((r) => {
      if (r.data) setTeam(r.data.team)
    })
    return onTeam(setTeam)
  }, [])

  async function remove(id: number) {
    // `.delete({})` — empty body is required (bodyless DELETE → 411). See GAPS S12.
    const { data } = await api.team({ id }).delete({})
    if (data) emitTeam(data.team)
  }

  const coverage = [...new Set(team.flatMap((m) => m.types))]

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 200 }}>
      {open && (
        <div
          className="aa-card"
          style={{
            width: 320,
            marginBottom: 12,
            boxShadow: 'var(--shadow-xl)',
            border: '1px solid var(--border-default)',
          }}
        >
          <div style={{ height: 3, background: 'var(--aa-gradient)' }} />
          <div
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 'var(--text-sm)',
              }}
            >
              My team
            </span>
            <span className="aa-pill aa-pill--muted aa-pill--no-dot" style={{ marginLeft: 'auto' }}>
              {team.length} / {MAX}
            </span>
          </div>

          {team.length === 0 ? (
            <div
              style={{
                padding: '28px 20px',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--text-xs)',
                lineHeight: 1.6,
              }}
            >
              ยังไม่มี Pokémon ในทีม
              <br />
              เปิดหน้า detail แล้วกด <b style={{ color: 'var(--text-secondary)' }}>Add to team</b>
            </div>
          ) : (
            <>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {team.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '9px 14px',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--surface-sunken)',
                        display: 'grid',
                        placeItems: 'center',
                        flex: 'none',
                      }}
                    >
                      <img
                        src={m.artwork}
                        alt={m.displayName}
                        style={{ width: 30, height: 30, objectFit: 'contain' }}
                      />
                    </div>
                    <a
                      href={`/pokemon/${m.name}`}
                      style={{ flex: 1, minWidth: 0, textDecoration: 'none' }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {m.displayName}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-3xs)',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        {m.num}
                      </div>
                    </a>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {m.types.map((t) => (
                        <span key={t} className={`dex-type dex-type--${t} dex-type--sm`}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="aa-btn aa-btn--ghost aa-btn--icon aa-btn--xs"
                      onClick={() => remove(m.id)}
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              {coverage.length > 0 && (
                <div
                  style={{
                    padding: '11px 14px',
                    background: 'var(--ink-25)',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <div
                    style={{
                      fontSize: 'var(--text-3xs)',
                      fontWeight: 700,
                      color: 'var(--text-tertiary)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      marginBottom: 7,
                    }}
                  >
                    Type coverage
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {coverage.map((t) => (
                      <span key={t} className={`dex-type dex-type--${t} dex-type--sm`}>
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
        className="aa-btn aa-btn--lg"
        onClick={() => setOpen((o) => !o)}
        style={{ boxShadow: 'var(--shadow-brand)', paddingInline: 18 }}
      >
        My team
        <span
          style={{
            marginLeft: 6,
            padding: '1px 8px',
            borderRadius: 'var(--radius-pill)',
            background: 'rgba(255,255,255,0.22)',
            fontWeight: 800,
            fontSize: 'var(--text-xs)',
          }}
        >
          {team.length}
        </span>
      </button>
    </div>
  )
}
