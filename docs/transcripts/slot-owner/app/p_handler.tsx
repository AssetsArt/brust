import { useState } from 'react'
import Box from './Box'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Box><button onClick={() => setOn(!on)}>in</button></Box></main> }
