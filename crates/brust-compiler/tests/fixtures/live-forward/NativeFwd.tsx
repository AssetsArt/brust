import { useState } from 'react'

// A native child (its own state) that forwards its rest: its root is its own host, so the parent cannot bind in its scope.
export default function NativeFwd({ ...rest }: any) {
  const [n, setN] = useState(0)
  return <input {...rest} data-n={n} onFocus={() => setN(n + 1)} />
}
