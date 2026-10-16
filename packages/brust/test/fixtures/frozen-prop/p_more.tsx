import { useState } from 'react'
import Mid2 from './Mid2'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Mid2 on={on} /></main> }
