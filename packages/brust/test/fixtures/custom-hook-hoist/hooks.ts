import { useId, useState } from 'react'

// F379: custom hooks called inside attribute values. One wraps useId (Radix's @radix-ui/react-id shape), one seeds a
// state from its argument.
export function useScopedId(prefix: string) {
  const id = useId()
  return prefix + '-' + id
}

export function useLabel(n: number) {
  const [x] = useState(n)
  return 'L' + x
}
