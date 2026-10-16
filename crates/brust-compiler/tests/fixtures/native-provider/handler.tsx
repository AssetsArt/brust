import { useState } from 'react'
import { P, PTrigger } from './Prov'
export default function Handler() { const [n, setN] = useState(0); return <main><P><PTrigger>go</PTrigger><button onClick={() => setN(n + 1)}>{n}</button></P></main> }
