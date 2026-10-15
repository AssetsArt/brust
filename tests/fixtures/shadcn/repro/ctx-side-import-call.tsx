import { add, items } from './ctx-side-store-call'
const _r = add('b')

export default function Page() {
  return <section>{items.join(',')}</section>
}
