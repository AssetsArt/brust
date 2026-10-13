// Demo, react tier: the same `team` store through the same hook, inside a React island (useReducer is what makes
// it React; useStore alone stays native). Removing a member runs the DELETE rule in the browser (team-client.ts); the
// native badge updates too.
import { useStore } from '@brust/core/store/react'
import { useEffect, useReducer } from 'react'
import { loadTeam, removeMember } from './team-client'
import { team } from './team-store'

const flip = (open: boolean): boolean => !open

export default function TeamIsland() {
  const s = useStore(team)
  const [open, toggle] = useReducer(flip, true)
  // The island hydrates against the snapshot the page was rendered with (F102), then follows the live store; loadTeam
  // fills it from storage after mount.
  useEffect(() => {
    loadTeam()
  }, [])
  const members = s.members
  const max = s.max
  return (
    <div className="team-island">
      <button type="button" className="demo-btn" aria-expanded={open} onClick={() => toggle()}>
        <span className="tier react">react</span> My team {members.length} / {max}
      </button>
      {open ? (
        <ul className="demo-list">
          {members.length === 0 ? <li className="empty">Empty. Add Pokémon on the Actions page or below.</li> : null}
          {members.map((m) => (
            <li key={m.id}>
              <img src={m.sprite} alt="" width={40} height={40} loading="lazy" />
              {m.name}
              <button type="button" className="demo-btn" onClick={() => removeMember(m.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
