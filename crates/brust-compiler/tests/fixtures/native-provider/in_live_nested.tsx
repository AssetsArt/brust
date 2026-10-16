import { useState } from 'react'
import { P, PTrigger } from './Prov'
export default function InLive() { const [n, setN] = useState(0); return <main onClick={() => setN(n + 1)}><P><PTrigger>{n}</PTrigger></P></main> }
