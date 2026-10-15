import { later } from 'brust-test-reg'
const cfg = { v: 'a' }
const _r = later(() => cfg)

export default function Page() {
  return <section>{cfg.v}</section>
}
