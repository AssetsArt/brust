// A callout box with a small tag ("Note" by default).
import type { ReactNode } from 'react'

export default function Note({ tag = 'Note', children }: { tag?: string; children: ReactNode }) {
  return (
    <div className="note">
      <span className="tag">{tag}</span>
      <p>{children}</p>
    </div>
  )
}
