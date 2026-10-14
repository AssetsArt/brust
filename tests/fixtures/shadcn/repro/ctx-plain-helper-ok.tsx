import { tag, loud } from './ctxlib/helpers'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{tag(3)}{loud('x')}</Wrap>
}
