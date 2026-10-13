// The standfirst under a docs page title: the first paragraph, larger and muted.
import type { ReactNode } from 'react'

export default function Lead({ children }: { children: ReactNode }) {
  return <p className="max-w-[62ch] text-[1.12rem] text-ink-2">{children}</p>
}
