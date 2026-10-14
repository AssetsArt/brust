import { ChevronRight } from 'lucide-react'

// No attribute of its own: whatever the call site passes reaches the icon.
export function Ico({ ...p }: React.ComponentProps<'svg'>) {
  return <ChevronRight {...p} />
}
