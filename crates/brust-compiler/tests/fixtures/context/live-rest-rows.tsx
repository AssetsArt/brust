import { useState } from 'react'

function Prim({ ...props }: any) {
  return <button {...props} />
}

function Toggle({ children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <Prim type="button" aria-pressed={pressed} {...buttonProps} onClick={() => setPressed(!pressed)}>
      {children}
    </Prim>
  )
}

// F329b negative (A6, v1): the live key sits in a list
export default function Page() {
  const [a, setA] = useState(false)
  return (
    <main>
      {['x', 'y'].map((k) => (
        <Toggle key={k} aria-checked={a}>
          {k}
        </Toggle>
      ))}
      <button type="button" onClick={() => setA(!a)}>
        flip
      </button>
    </main>
  )
}
