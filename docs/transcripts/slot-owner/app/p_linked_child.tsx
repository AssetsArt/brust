import { useState } from 'react'
import Box from './Box'
import Thumb from './Thumb'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Box><Thumb on={on} /></Box></main> }
