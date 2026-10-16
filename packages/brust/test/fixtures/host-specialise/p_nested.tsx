import { useState } from 'react'
import { P, PTrigger } from './Prov'
export default function Page() { const [n, setN] = useState(0); return <main><button data-testid="f" onClick={() => setN(n + 1)}>f</button><P><PTrigger>{n}</PTrigger></P></main> }
