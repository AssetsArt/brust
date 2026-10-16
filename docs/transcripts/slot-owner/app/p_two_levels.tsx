import { useState } from 'react'
import Outer from './Outer'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Outer><b>{on ? 'a' : 'b'}</b></Outer></main> }
