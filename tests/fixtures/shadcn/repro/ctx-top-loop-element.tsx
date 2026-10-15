import { list } from './ctxlib/els'

export default function Page() {
  return <ul>{list.map((x, i) => <li key={i}>{x}</li>)}</ul>
}
