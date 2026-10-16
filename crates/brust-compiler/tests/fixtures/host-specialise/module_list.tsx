import { useState } from 'react'
import Box from './Box'
import { USERS } from './data'
export default function Page() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><Box><b>{on ? 'a' : 'b'}</b>{USERS.map((u) => <i key={u.name}>{u.name}</i>)}</Box></main> }
