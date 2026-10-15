import { items, add } from './side-store'
const _r = add('b')
export default function Page() {
  return <section>{items.join(',')}</section>
}
