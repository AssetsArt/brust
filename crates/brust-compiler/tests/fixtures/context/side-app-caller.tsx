import { items, add } from './side-store'
function init() {
  add('b')
  return 1
}
const _r = init()
export default function Page() {
  return <section>{items.join(',')}</section>
}
