import * as React from 'react'

// A forwardRef component that hands its ref to the one element it renders (F267)
export const Fb = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'>>(function Fb({ children, ...rest }, ref) {
  return (
    <button type="button" {...rest} ref={ref}>
      {children}
    </button>
  )
})
