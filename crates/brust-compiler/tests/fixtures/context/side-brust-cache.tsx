import { cache } from 'brust'
import { cfg } from './lib/lib2'
const xs = ['a']
function Card() {
  return <p>{cfg.v}</p>
}
export const Cached = cache(Card, { revalidate: 60 })
function get() {
  return xs.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
