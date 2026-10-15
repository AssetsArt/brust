import { register } from 'brust-test-reg'
import { cfg } from './ctxlib/lib2'
const _r = register(cfg)

export default function Page() {
  return <section>{cfg.v}</section>
}
