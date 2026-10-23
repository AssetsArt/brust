import { useState } from 'react'
import { P, PTrigger } from './Prov'
// F271: a handler of the call site that takes the event argument, written in the content.
export default function HandlerEvent() {
  const [n, setN] = useState(0)
  return <main><P><PTrigger>go</PTrigger><button onClick={(e) => setN(n + e.detail)}>{n}</button></P></main>
}
