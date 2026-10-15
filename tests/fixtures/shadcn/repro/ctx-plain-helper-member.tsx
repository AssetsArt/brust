import { pick } from './ctxlib/helpers'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{pick({ name: 'n' })}</Wrap>
}
