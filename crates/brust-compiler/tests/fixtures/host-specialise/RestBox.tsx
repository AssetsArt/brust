import { useState } from 'react'
export default function RestBox({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} data-n={n} onClick={() => setN(n + 1)} />
}
