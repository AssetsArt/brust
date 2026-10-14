import { cva } from 'class-variance-authority'
import { cn } from 'cn'
import { marker } from 'radix-ui'

export const buttonVariants = cva('inline-flex', { variants: { size: { sm: 'h-8', icon: 'size-9' } }, defaultVariants: { size: 'sm' } })

export function Button({ className, size, ...props }: { className?: string; size?: 'sm' | 'icon'; children?: React.ReactNode }) {
  return <button data-m={marker} className={cn(buttonVariants({ size }), className)} {...props} />
}
