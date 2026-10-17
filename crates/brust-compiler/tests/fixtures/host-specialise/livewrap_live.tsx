import { useState } from 'react'
import { LiveWrap } from './WrapV'
export default function Page() { const [v, setV] = useState(0); return <main><button onClick={() => setV(v + 1)}>f</button><LiveWrap value={v} /></main> }
