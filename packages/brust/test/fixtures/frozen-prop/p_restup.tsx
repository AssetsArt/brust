import { useState } from 'react'
import Wrap from './Wrap'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Wrap on={on} /></main> }
