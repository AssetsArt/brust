import { useState } from 'react'
import Pair from './Pair'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Pair>{on ? 'a' : 'b'}</Pair></main> }
