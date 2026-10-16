import { useState } from 'react'
import { useDirection } from './dirmod'

// a native component (state) that reads the direction the way Radix's groups do
export function DirBox({ dir }: { dir?: 'ltr' | 'rtl' }) {
  const direction = useDirection(dir)
  const [n, setN] = useState(0)
  return (
    <div dir={direction} data-n={n} onClick={() => setN(n + 1)}>
      {direction}
    </div>
  )
}
