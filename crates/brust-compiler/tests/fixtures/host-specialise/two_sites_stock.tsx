import { useState } from 'react'
import Box from './Box'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Box><b>fixed</b></Box><Box><b>also</b></Box></main> }
