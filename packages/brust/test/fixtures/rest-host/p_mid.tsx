import { useState } from 'react'
import Mid from './Mid'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Mid><b>{on ? 'a' : 'b'}</b></Mid></main> }
