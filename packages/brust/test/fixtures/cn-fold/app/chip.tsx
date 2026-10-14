import { cn } from 'cn'
import { tone } from 'tones'

export function Chip({ className }: { className?: string }) {
  return <i className={cn(tone, className)}>chip</i>
}
