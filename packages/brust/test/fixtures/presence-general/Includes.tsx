import * as React from 'react'

// F287: `[literals].includes(x)` over state seeded from a prop the page changes.
export function Gate(props: { open: boolean; n: number }) {
  const [s, setS] = React.useState(props.open ? 'a' : 'c')
  React.useEffect(() => { setS(props.open ? 'a' : 'c') }, [props.open])
  const shown = ['a', 'b'].includes(s)
  const odd = [2, 1, 3].includes(props.n)
  const none = [null, 0].includes(props.n)
  return (
    <section>
      <p data-testid="shown" hidden={!shown}>shown</p>
      <p data-testid="odd">{odd ? 'yes' : 'no'}</p>
      <p data-testid="none">{none ? 'yes' : 'no'}</p>
    </section>
  )
}
