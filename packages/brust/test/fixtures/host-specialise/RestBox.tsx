import { useState } from 'react'
// S1 (F324): a native child whose children reach its element only through its `...rest`: never cloned by F307.
export default function RestBox({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} data-testid="box" data-n={n} onClick={() => setN(n + 1)} />
}
