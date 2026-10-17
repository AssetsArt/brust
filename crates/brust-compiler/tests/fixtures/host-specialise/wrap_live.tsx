import { useState } from 'react'
import { Wrap } from './WrapV'
export default function Page() { const [v, setV] = useState(0); return <main><button onClick={() => setV(v + 1)}>f</button><Wrap value={v} /></main> }
