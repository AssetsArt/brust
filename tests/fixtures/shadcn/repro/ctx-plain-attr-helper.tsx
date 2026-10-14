import { cn } from './ctxlib/helpers'

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

function Box({ className }: { className?: string }) {
  return <i className={className} />
}

export default function Page({ on }: { on?: boolean }) {
  return (
    <Wrap>
      <div className={cn('a', on && 'b')}>x</div>
      <Box className={cn('c', on && 'd')} />
    </Wrap>
  )
}
