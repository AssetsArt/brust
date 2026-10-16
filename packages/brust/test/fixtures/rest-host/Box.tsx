import { useState } from 'react'
// F342: prints no `{children}`; its `...rest` carries the call site's children onto its host element.
export default function Box({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} data-testid="box" data-n={n} onClick={() => setN(n + 1)} />
}
