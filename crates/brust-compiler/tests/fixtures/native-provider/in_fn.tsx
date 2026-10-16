import { P, PTrigger } from './Prov'
function fmt(n: number) { return `#${n}` }
export default function InFn() { return <main><P><PTrigger>{fmt(1)}</PTrigger></P></main> }
