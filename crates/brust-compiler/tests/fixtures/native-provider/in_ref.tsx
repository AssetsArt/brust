import { useRef, useState } from 'react'
import { P, PTrigger } from './Prov'
export default function InRef() { const r = useRef<HTMLElement>(null); const [n, setN] = useState(0); return <main onClick={() => setN(n + 1)}><P><PTrigger>x</PTrigger><i ref={r}>{n}</i></P></main> }
