import { add, items } from './ctx-side-store'
add('b')

export default function Page() {
  return <section>{items.join(',')}</section>
}
