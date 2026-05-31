import { useState } from 'react'
export default function HookBadge({ label }: { label: string }) {
  const [n] = useState(0)
  return <span class="hbadge">{label}{n}</span>
}
