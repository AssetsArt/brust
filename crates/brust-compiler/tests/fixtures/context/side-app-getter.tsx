import { items, o } from './lib/getter'
const n = o.v
export default function Page() {
  return <section>{items.join(',')}</section>
}
