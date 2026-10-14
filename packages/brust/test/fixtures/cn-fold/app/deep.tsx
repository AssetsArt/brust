import { cva } from 'class-variance-authority'
import { cn } from 'cn'

const deepVariants = cva('deep', { variants: { variant: { default: 'v-default', loud: 'v-loud' } }, defaultVariants: { variant: 'default' } })

// The job reads `config.variant`: a deep input whose leaf the call site leaves out (review F1).
export function Deep({ config }: { config: { variant?: 'default' | 'loud' } }) {
  return <b className={cn(deepVariants({ variant: config.variant }))}>deep</b>
}
