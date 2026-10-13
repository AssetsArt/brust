// A tier tag: a small square and the tier's name in the tier's colour (static, native or react).
import type { ReactNode } from 'react'

const COLOR = {
  static: 'text-t-static before:bg-t-static',
  native: 'text-t-native before:bg-t-native',
  react: 'text-t-react before:bg-t-react',
}

export default function Tier({ t, children }: { t: keyof typeof COLOR; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-[.35rem] font-mono text-[12px] before:h-2 before:w-2 before:rounded-[2px] before:content-[''] ${COLOR[t]}`}>{children}</span>
  )
}
