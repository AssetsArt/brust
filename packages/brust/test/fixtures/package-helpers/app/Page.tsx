import { loud, tag } from 'plain-fmt'

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return (
    <Wrap>
      <b>{tag(3.4)}</b>
      <i>{loud('hi')}</i>
    </Wrap>
  )
}
