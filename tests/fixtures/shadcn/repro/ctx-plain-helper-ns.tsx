import * as h from './ctxlib/helpers'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{h.later(1)}</Wrap>
}
