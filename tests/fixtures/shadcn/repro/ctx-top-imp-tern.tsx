import { el } from './ctxlib/els'

export default function Page() {
  const on = true
  return <section>{on ? el : null}</section>
}
