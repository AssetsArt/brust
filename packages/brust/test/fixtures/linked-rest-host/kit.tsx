// battery row c-rest-children-linked-host (F298 + F309 + F307), served since F337: native, == React.
import { createContext, useContext, useState } from 'react'
const K = createContext({ on: false, flip: () => {} })
function KProvider({ children }: any) { const [on, setOn] = useState(false); return <K.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</K.Provider> }
function Flip() { const c = useContext(K); return <button data-testid="flip" onClick={c.flip}>flip</button> }
function Label({ children, ...rest }: any) { return <span {...rest}>{children}</span> }
function LiveLabel({ children, ...rest }: any) { const c = useContext(K); return <span {...rest} data-on={String(c.on)}>{children}</span> }
export function Thumb() { const c = useContext(K); return <i data-state={c.on ? 'checked' : 'unchecked'} /> }
export function Root({ ...rest }: any) { return <KProvider><Flip /><Label {...rest} /></KProvider> }
export function LiveRoot({ ...rest }: any) { return <KProvider><Flip /><LiveLabel {...rest} /></KProvider> }