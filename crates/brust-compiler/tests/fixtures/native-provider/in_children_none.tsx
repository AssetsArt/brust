import * as React from 'react'
import { useState } from 'react'
import { P, PTrigger } from './Prov'
function Wrap({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return <main><button onClick={() => setN(n + 1)}>{n}</button><P><PTrigger>{children}</PTrigger></P></main>
}
export default function InChildrenNone() { return <Wrap /> }
