// Demo, native tier: tabs over plain-text panels (a command and its output, a before/after); one useState picks the
// panel, the others are hidden. Everything is server-rendered, so it reads fine without JavaScript too.
import { useEffect, useRef, useState } from 'react'

export default function SwitchPanels({ label, panels }: { label: string; panels: { id: string; tab: string; note: string; text: string }[] }) {
  const root = useRef<HTMLDivElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [on, setOn] = useState(panels[0]!.id)
  return (
    <div className="switch">
      <div className="tabs" role="tablist" aria-label={label} ref={root}>
        {panels.map((p) => (
          <button key={p.id} type="button" role="tab" aria-selected={on === p.id} onClick={() => setOn(p.id)}>
            <b>{p.tab}</b>
          </button>
        ))}
      </div>
      {panels.map((p) => (
        <div key={p.id} role="tabpanel" hidden={on !== p.id}>
          <p className="vp-note">{p.note}</p>
          <pre className="cmd">
            <code>{p.text}</code>
          </pre>
        </div>
      ))}
    </div>
  )
}
