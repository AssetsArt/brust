import { items, o } from './ctxlib/getter'
const n = o.v

export default function Page() {
  return <section>{items.join(',')}</section>
}
