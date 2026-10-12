// Demo, native tier: tabs over plain-text panels (a command and its output, a before/after); one useState picks the
// panel, the others are hidden. Everything is server-rendered, so it reads fine without JavaScript too.
import { useState } from 'react'

export default function SwitchPanels({ label, panels }: { label: string; panels: { id: string; tab: string; note: string; text: string }[] }) {
  const [on, setOn] = useState(panels[0]!.id)
  return (
    <div className="switch">
      <div className="tabs" role="tablist" aria-label={label}>
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
