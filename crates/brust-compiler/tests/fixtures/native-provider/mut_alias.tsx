import { Lbl } from './Rend'
const P0 = { text: 'a', tone: 'sm' }
const Q = P0
Q.tone = 'lg'
export default function P() { return <main><Lbl {...P0} /></main> }
