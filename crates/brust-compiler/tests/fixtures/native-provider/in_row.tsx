import { P, PTrigger } from './Prov'
export default function InRow({ items }: { items: number[] }) { return <main>{items.map((i) => (<P key={i}><PTrigger>{i}</PTrigger></P>))}</main> }
