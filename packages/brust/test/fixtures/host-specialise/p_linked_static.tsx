import { useState } from 'react'
import Label from './Label'
import Thumb from './Thumb'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><Label on={on}><Thumb on={on} /></Label></main> }
