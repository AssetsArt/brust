// forwardRef components as libraries and shadcn's older registry write them: a function callback, an arrow with rest props, an alias export.
import * as React from 'react'

const Label = React.forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<'label'>>(function Label({ className, ...props }, ref) {
  return <label ref={ref} className={className} {...props} />
})

export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<'input'>>(({ className, type, ...props }, ref) => (
  <input ref={ref} type={type ?? 'text'} className={className} {...props} />
))

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card({ className, ...props }, forwardedRef) {
  return <div ref={forwardedRef} data-slot="card" className={className} {...props} />
})

export { Label, Card, Card as Root }
