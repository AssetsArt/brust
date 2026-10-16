import { createContext, useState } from 'react'

// F324: a Provider component that spreads its `...rest` onto an element and never prints `{children}`. In React the
// call site's children reach the button through the rest.
const C = createContext({ on: false })
export function Root({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const [on, setOn] = useState(false)
  return (
    <C.Provider value={{ on }}>
      <button type="button" onClick={() => setOn(!on)} {...rest} />
    </C.Provider>
  )
}
