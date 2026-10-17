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

// F329b (W3): the caller's LIVE `aria-pressed` replaces the one the child binds itself, with a binding of its own
export default function Page() {
  const [a, setA] = useState(false)
  return (
    <main>
      <Toggle aria-pressed={a}>one</Toggle>
      <button type="button" onClick={() => setA(!a)}>
        flip
      </button>
    </main>
  )
}
