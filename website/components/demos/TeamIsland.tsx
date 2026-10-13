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
    <div className="team-island grid gap-3">
      <button type="button" className="cursor-pointer rounded-xs border border-ink bg-paper px-[.7rem] py-[.35rem] text-ink tabular-nums [font-family:inherit] [line-height:inherit] text-[14px] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]" aria-expanded={open} onClick={() => toggle()}>
        <span className="inline-block min-w-[1ch] font-mono text-[12px] text-t-react">react</span> My team {members.length} / {max}
      </button>
      {open ? (
        <ul className="m-0 grid list-none grid-cols-2 gap-x-[.9rem] gap-y-[.35rem] pl-[1.2rem] text-[14.5px] max-narrow:grid-cols-1">
          {members.length === 0 ? <li className="col-span-full text-ink-2">Empty. Add Pokémon on the Actions page or below.</li> : null}
          {members.map((m) => (
            <li key={m.id} className="motion-safe:animate-[rise_.2s_ease-out_both] my-[.3rem] flex max-w-[68ch] min-w-0 items-center gap-[.4rem]">
              <img src={m.sprite} alt="" width={40} height={40} loading="lazy" className="size-10 flex-none [image-rendering:pixelated]" />
              {m.name}
              <button type="button" className="ml-auto cursor-pointer rounded-xs border border-ink bg-paper px-[.7rem] py-[.35rem] text-ink tabular-nums [font-family:inherit] [line-height:inherit] text-[14px] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]" onClick={() => removeMember(m.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
