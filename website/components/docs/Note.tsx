// A callout box with a small tag ("Note" by default).
import type { ReactNode } from 'react'

export default function Note({ tag = 'Note', children }: { tag?: string; children: ReactNode }) {
  return (
    <div className="grid max-w-[68ch] grid-cols-[auto_1fr] gap-[.9rem] rounded-[2px] border border-rule bg-sheet px-4 py-[.85rem] text-[15px]">
      <span className="mt-[.15rem] h-fit rounded-[3px] bg-amber-fill px-[.4rem] py-[.05rem] font-mono text-[11px] text-on-amber">{tag}</span>
      <p>{children}</p>
    </div>
  )
}
