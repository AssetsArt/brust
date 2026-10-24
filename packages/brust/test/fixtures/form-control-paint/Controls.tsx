import type { ComponentProps } from 'react'

// The shadcn wrapper shape: the control gets its props, value included, through a spread.
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={`sel ${className ?? ''}`} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={`ta ${className ?? ''}`} {...props} />
}
