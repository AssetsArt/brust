import { useState } from 'react'
import Box from './Box'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Box><b>{on ? 'a' : 'b'}</b></Box></main> }
