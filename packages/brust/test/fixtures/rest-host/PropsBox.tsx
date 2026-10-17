import { useState } from 'react'
// F342: the same through the whole props object.
export default function PropsBox(props: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...props} data-testid="box" data-n={n} onClick={() => setN(n + 1)} />
}
