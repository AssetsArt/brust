import { register } from 'some-registry'
import { cfg } from './lib/lib2'
const _r = register(cfg)
export default function Page() {
  return <section>{cfg.v}</section>
}
