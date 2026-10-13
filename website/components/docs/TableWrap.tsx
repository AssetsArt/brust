// A docs table that scrolls sideways inside a bordered frame instead of widening the page. With a `label` the frame is a
// focusable named region, so a keyboard user can scroll it. The table's own rows and cells are styled by the `.doc` prose
// rules in app.css (the page writes a bare <table>).
import type { ReactNode } from 'react'

export default function TableWrap({ label, children }: { label?: string; children: ReactNode }) {
  return (
    // the 34rem floor applies only here, where the frame scrolls; a bare table must shrink with the column
    <div
      tabIndex={label ? 0 : undefined}
      role={label ? 'region' : undefined}
      aria-label={label}
      className="overflow-x-auto rounded-[2px] border border-rule bg-sheet focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber [&_table]:min-w-[34rem]"
    >
      {children}
    </div>
  )
}
