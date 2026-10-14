import { label } from './ctxlib/helpers'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{label('a')}</Wrap>
}
