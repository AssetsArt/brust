import { createContext, useContext } from 'react'

const Scalar = createContext('x')

function Show({ id }: { id: string }) {
  const v = useContext(Scalar)
  return <p data-testid={id}>{v}</p>
}

// F431 guard (was a wrong paint: both read 'x'): a Provider written inline in the page does not frame its content
// (F446), so the child's need is not answered by the default: the page falls back by name and paints React's 'y'.
export default function InlinePage() {
  return (
    <main>
      <Show id="outside" />
      <Scalar.Provider value="y">
        <Show id="inside" />
      </Scalar.Provider>
    </main>
  )
}
