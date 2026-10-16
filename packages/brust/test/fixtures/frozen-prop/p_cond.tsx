import { useState } from 'react'
import Mid6 from './Mid6'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Mid6 on={on} /></main> }
