import { ChevronRight } from 'lucide-react'

export function Sep({ children, ...props }: React.ComponentProps<'li'>) {
  return (
    <li data-slot="sep" role="presentation" {...props}>
      {children ?? <ChevronRight />}
    </li>
  )
}

export function Fallback({ label }: { label?: string }) {
  return <p data-slot="fallback">{label || <i>none</i>}</p>
}
