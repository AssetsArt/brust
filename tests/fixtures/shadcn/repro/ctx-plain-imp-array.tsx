import { el } from './ctxlib/els'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{[el]}</Wrap>
}
