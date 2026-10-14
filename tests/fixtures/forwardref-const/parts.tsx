import * as React from 'react'

const Label = React.forwardRef<HTMLLabelElement, React.ComponentProps<'label'>>(function Label({ className, ...props }, ref) {
  return <label ref={ref} className={className} {...props} />
})

export const Input = React.forwardRef<HTMLInputElement, { id?: string }>(({ id }, forwardedRef) => (
  <input ref={forwardedRef} id={id} />
))

export { Label, Label as Root }
