import { useState } from 'react'
import { label } from './fsread'

export default function Page(props: { name: string }) {
  const [n, setN] = useState(0)
  return (
    <section>
      <h1>{label(props.name)}</h1>
      <button onClick={() => setN(n + 1)}>n={n}</button>
    </section>
  )
}
