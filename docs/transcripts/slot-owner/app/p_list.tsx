import { useState } from 'react'
import Box from './Box'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Box>{[1, 2].map((i) => <b key={i}>{on ? i : -i}</b>)}</Box></main> }
