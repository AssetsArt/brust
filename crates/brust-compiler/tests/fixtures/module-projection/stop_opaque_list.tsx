import { useState, useRef } from 'react'
const ITEMS = [{ id: 1, name: 'a', secret: 'SECRET_A' }, { id: 2, name: 'b', secret: 'SECRET_B' }]
export default function P() { const [s, setS] = useState(0); const label = (() => { return ITEMS[0].secret })(); return <div data-l={s ? label : ""}><ul>{ITEMS.map((it) => <li key={it.id} onClick={() => setS(it.id)}>{it.name}</li>)}</ul></div> }
