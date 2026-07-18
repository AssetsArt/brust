import Counter from './components/Counter'
import HookBadge from './components/HookBadge'
import MenuSkeleton from './components/MenuSkeleton'

export default function NativeIslandPage({
  greeting,
  count,
}: {
  greeting: string
  count: { start: number }
}) {
  return (
    <div>
      <h1>{greeting}</h1>
      <Island
        component={Counter}
        props={count}
        fallback={
          <>
            <MenuSkeleton label={greeting} />
            <HookBadge label={greeting} />
          </>
        }
      />
    </div>
  )
}
