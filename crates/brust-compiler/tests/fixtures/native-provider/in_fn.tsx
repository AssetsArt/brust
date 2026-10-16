import { P, PTrigger } from './Prov'
// two statements: not a single-return helper (F279 would put its expression in), so the name still has to cross
function fmt(n: number) {
  const s = `#${n}`
  return s
}
export default function InFn() { return <main><P><PTrigger>{fmt(1)}</PTrigger></P></main> }
