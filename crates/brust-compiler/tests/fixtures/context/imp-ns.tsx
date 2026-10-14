import * as els from './lib/els'

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return (
    <Wrap>
      {els.el}
      {els.text}
    </Wrap>
  )
}
