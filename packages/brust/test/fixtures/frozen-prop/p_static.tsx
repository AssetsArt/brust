import { useState } from 'react'
import Mid4 from './Mid4'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Mid4 on={on} /></main> }
