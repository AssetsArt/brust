import { P, PTrigger } from './Prov'
function Local() { return <i>local</i> }
export default function L() { return <main><P><PTrigger>x</PTrigger><Local /></P></main> }
