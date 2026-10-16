import { useState } from 'react'
import RestBox from './RestBox'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><RestBox><b>{on ? 'a' : 'b'}</b></RestBox></main> }
