import { cn } from './cn'
import { KRoot, KThumb } from './Kit'
// the same with a constant call (shadcn's own Thumb: cn over string literals only)
export default function Page() {
  return (
    <main>
      <KRoot data-x="1">
        <KThumb className={cn('thumb', 'round')} />
      </KRoot>
    </main>
  )
}
