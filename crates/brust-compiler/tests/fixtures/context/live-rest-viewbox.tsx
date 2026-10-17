import { useState } from 'react'

function Prim({ ...props }: any) {
  return <svg {...props} />
}

function Icon({ children, ...svgProps }: any) {
  const [n, setN] = useState(0)
  return (
    <Prim width="10" {...svgProps} data-n={n} onClick={() => setN(n + 1)}>
      {children}
    </Prim>
  )
}

// F329b negative (Afrojack r1): `viewBox` is camelCase in the DOM; `x-prop-viewbox` could only add a second attribute
export default function Page() {
  const [a, setA] = useState('0 0 10 10')
  return (
    <main>
      <Icon viewBox={a}>x</Icon>
      <button type="button" onClick={() => setA('0 0 20 20')}>
        flip
      </button>
    </main>
  )
}
