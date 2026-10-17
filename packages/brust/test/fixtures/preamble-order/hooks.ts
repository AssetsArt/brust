import { useState } from 'react'

// F385: hooks whose ARGUMENT their value reads. Inlined at the call site, the argument's binding carries the call
// site's source location while these bodies carry this module's: the server must still set the argument first.
export function useLabel(n: number) {
  return 'L' + n
}

function useInner(m: number) {
  const [x] = useState(m)
  return 'I' + x
}

export function useOuter(n: number) {
  const v = useInner(n + 1)
  return v + '!'
}
