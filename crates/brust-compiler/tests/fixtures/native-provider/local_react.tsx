import { useSyncExternalStore } from 'react'
import { P, PTrigger } from './Prov'
function Local() { const v = useSyncExternalStore(() => () => {}, () => 1, () => 1); return <i>{v}</i> }
export default function L() { return <main><P><PTrigger>x</PTrigger><Local /></P></main> }
