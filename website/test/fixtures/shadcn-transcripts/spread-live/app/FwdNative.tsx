import { useState } from 'react'
export default function FwdNative({ ...props }: any) {
  const [n, setN] = useState(0)
  return <input type="checkbox" {...props} data-n={n} onFocus={() => setN(n + 1)} />
}
