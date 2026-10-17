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

// F329b negative (v1): className and style are not bound through a native child's rest; the URL attributes and `value` neither
export default function Page() {
  const [a, setA] = useState(false)
  return (
    <main>
      <Toggle className={a ? 'on' : 'off'}>one</Toggle>
      <button type="button" onClick={() => setA(!a)}>
        flip
      </button>
    </main>
  )
}
