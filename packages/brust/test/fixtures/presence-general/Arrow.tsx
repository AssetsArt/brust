import * as React from 'react'

// F284: a component declared as an arrow-const, exported by name and under an alias.
const Counter: React.FC<{ start: number; label: string }> = (props) => {
  const { start, label } = props
  const [n, setN] = React.useState(start)
  return (
    <button type="button" data-testid={label} onClick={() => setN(n + 1)}>
      {label}:{n}
    </button>
  )
}

export { Counter, Counter as Root }
