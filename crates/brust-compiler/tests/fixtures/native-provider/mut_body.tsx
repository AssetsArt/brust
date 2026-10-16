import { Lbl } from './Rend'
export default function P() {
  const attrs = { text: 'a', tone: 'sm' }
  attrs.tone = 'lg'
  return <main><Lbl {...attrs} /></main>
}
