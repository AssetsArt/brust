import { cva } from 'class-variance-authority'
import { cn } from 'cn'

const badgeVariants = cva('inline-flex rounded-full', {
  variants: { variant: { default: 'bg-primary', secondary: 'bg-secondary', boom: 'never' } },
  defaultVariants: { variant: 'default' },
})

export function Badge({ className, variant, ...props }: { className?: string; variant?: 'default' | 'secondary' | 'boom'; children?: React.ReactNode }) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}
