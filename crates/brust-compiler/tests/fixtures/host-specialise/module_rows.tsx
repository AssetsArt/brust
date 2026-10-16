import { useState } from 'react'
import Lister from './Lister'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Lister label="x"><b>{on ? 'a' : 'b'}</b></Lister></main> }
