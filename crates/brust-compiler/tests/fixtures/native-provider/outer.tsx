import { P, PTrigger, Q, QTrigger } from './Prov'
export default function Outer() { return <main><P><Q><PTrigger>outer reader</PTrigger><QTrigger>inner</QTrigger></Q></P></main> }
