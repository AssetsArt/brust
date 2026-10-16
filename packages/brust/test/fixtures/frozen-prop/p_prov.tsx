import { useState } from 'react'
import { P } from './Prov'
import Thumb from './Thumb'
export default function Page() { const [on, setOn] = useState(false); return <main><button data-testid="f" onClick={() => setOn(!on)}>f</button><P>{[1, 2].map((i) => <b key={i}>{on ? i : -i}</b>)}<Thumb on={on} /></P></main> }
