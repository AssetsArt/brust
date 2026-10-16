import { useState } from 'react'
import Mid5 from './Mid5'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Mid5 x={1} on={on} /></main> }
