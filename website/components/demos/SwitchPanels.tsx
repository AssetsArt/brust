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
    <div className="switch grid min-w-0 gap-3">
      <div className="relative flex gap-0 overflow-x-auto border-b border-rule" role="tablist" aria-label={label} ref={root}>
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={on === p.id}
            onClick={() => setOn(p.id)}
            className="grid cursor-pointer gap-[.1rem] rounded-xs border-0 bg-transparent px-4 py-[.55rem] text-left whitespace-nowrap text-ink-2 [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit] aria-selected:text-ink"
          >
            <b className="text-[15px] font-semibold text-ink">{p.tab}</b>
          </button>
        ))}
      </div>
      {panels.map((p) => (
        <div key={p.id} role="tabpanel" hidden={on !== p.id} className="pt-3">
          <p className="max-w-[68ch] text-[13.5px] text-ink-2">{p.note}</p>
          <pre className="m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg">
            <code>{p.text}</code>
          </pre>
        </div>
      ))}
    </div>
  )
}
