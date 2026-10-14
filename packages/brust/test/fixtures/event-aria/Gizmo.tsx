import { useState } from 'react'

// F195/F196: React's own attribute and event semantics on a native component. `start` is the initial state.
export default function Gizmo({ start }: { start: boolean }) {
  const [on, setOn] = useState(start)
  const [outer, setOuter] = useState(0)
  return (
    <div data-testid="outer" data-outer={outer} onClick={() => setOuter(outer + 1)}>
      <button
        type="button"
        data-testid="btn"
        aria-pressed={on}
        data-on={on}
        draggable={on}
        spellCheck={on}
        hidden={!on}
        download={on}
        // @ts-expect-error `title` is a string attribute: React omits a boolean
        title={on}
        onClick={(e) => {
          if (e.isPropagationStopped()) return
          e.persist()
          if (!e.isDefaultPrevented()) e.stopPropagation()
          setOn(!on)
        }}
      >
        {on ? 'on' : 'off'}
      </button>
    </div>
  )
}
