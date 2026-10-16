import { useState } from 'react'
import Mid3 from './Mid3'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Mid3 on={on} /></main> }
