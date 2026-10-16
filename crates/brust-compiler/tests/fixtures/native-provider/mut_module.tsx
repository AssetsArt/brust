import { Lbl } from './Rend'
const CFG = { text: 'a', tone: 'sm' }
CFG.tone = 'lg'
export default function P() { return <main><Lbl {...CFG} /></main> }
