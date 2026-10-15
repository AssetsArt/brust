// F234: a native child whose prop default is applied by destructuring. React takes the default when the prop is absent
// or `undefined`, and keeps an explicit `null`.
import { useState } from 'react'

export default function Ch({ defaultOpen = false, id }: { defaultOpen?: boolean | null; id: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <button data-testid={id} aria-expanded={open as any} onClick={() => setOpen(!open)}>
      {String(open)}
    </button>
  )
}
