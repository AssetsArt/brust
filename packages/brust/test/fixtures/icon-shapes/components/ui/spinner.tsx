import { Loader2Icon } from 'lucide-react'

export function Spinner({ ...props }: React.ComponentProps<'svg'>) {
  return <Loader2Icon role="status" aria-label="Loading" {...props} />
}
