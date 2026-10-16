import { useState } from 'react'
import Mid from './Mid'
export default function Page() { const [o, setO] = useState({ on: false }); return <main><button data-testid="f" onClick={() => setO({ on: !o.on })}>f</button><Mid {...o} /></main> }
