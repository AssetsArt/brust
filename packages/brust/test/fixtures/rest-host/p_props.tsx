import { useState } from 'react'
import PropsBox from './PropsBox'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><PropsBox><button onClick={() => setOn(!on)}>in</button><b>{on ? 'a' : 'b'}</b></PropsBox></main> }
