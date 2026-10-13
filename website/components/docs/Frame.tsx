// A live demo in a browser-like frame: a bar with the demo's name and its tier label, then the demo.
// `browser` stays as a hook class with no rule of its own for this component: a few demos inside the frame are styled
// by `.doc .browser .vp` in app.css until their lane migrates. `nvp` is the two-column viewport of the native demos; `bare`
// is a frame whose demo brings its own viewport.
import type { ReactNode } from 'react'

export default function Frame({ title, label, nvp, bare, children }: { title: string; label: string; nvp?: boolean; bare?: boolean; children: ReactNode }) {
  return (
    <div className="browser flex min-w-0 flex-col overflow-hidden rounded-[2px] border border-rule bg-sheet">
      <div className="flex justify-between gap-4 border-b border-rule bg-paper px-[.8rem] py-[.45rem] font-mono text-[12px] text-ink-2">
        <span>{title}</span>
        <span className="text-amber-ink">{label}</span>
      </div>
      {bare ? (
        children
      ) : (
      <div className={`vp min-h-0 flex-1 p-5${nvp ? ' nvp grid grid-cols-[minmax(0,1fr)_minmax(0,13rem)] items-stretch gap-4 max-narrow:grid-cols-1' : ''}`}>{children}</div>
      )}
    </div>
  )
}
