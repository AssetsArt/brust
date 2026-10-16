import { useState } from 'react'
import Gate from './Gate'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Gate><b>{on ? 'a' : 'b'}</b></Gate></main> }
