import { later } from 'some-later'
import { cfg } from './lib/lib2'
const _r = later(() => cfg)
export default function Page() {
  return <section>{cfg.v}</section>
}
