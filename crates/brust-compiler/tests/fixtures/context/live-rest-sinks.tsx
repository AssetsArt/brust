import { useState } from 'react'

function Prim({ ...props }: any) {
  return <button {...props} />
}

function Toggle({ children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <div>
      <Prim type="button" aria-pressed={pressed} {...buttonProps} onClick={() => setPressed(!pressed)}>
        {children}
      </Prim>
      <i {...buttonProps} />
    </div>
  )
}

// F329b negative: the rest is spread onto TWO places, so the key would land twice
export default function Page() {
  const [a, setA] = useState(false)
  return (
    <main>
      <Toggle aria-checked={a}>one</Toggle>
      <button type="button" onClick={() => setA(!a)}>
        flip
      </button>
    </main>
  )
}
