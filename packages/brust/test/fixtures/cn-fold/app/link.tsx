import { cn } from 'cn'
import { buttonVariants } from './button'

export function PageLink({ className, size = 'icon', ...props }: { className?: string; size?: 'sm' | 'icon'; href: string; children?: React.ReactNode }) {
  return <a className={cn(buttonVariants({ size }), className)} {...props} />
}
