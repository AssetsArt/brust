import * as React from 'react'
import { useState } from 'react'
import { P, PTrigger } from './Prov'
// F271: the call site's own `children` read in the content crosses as a hidden input of the clone.
function Wrap({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return <main><button onClick={() => setN(n + 1)}>{n}</button><P><PTrigger>{children}</PTrigger></P></main>
}
export default function InChildren() { return <Wrap>kids</Wrap> }
