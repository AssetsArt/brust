import InlineBadge from './components/InlineBadge'
import HookBadge from './components/HookBadge'
import WrapCounter from './components/WrapCounter'
export default function NativeInline({
  label,
  strong,
  count,
}: {
  label: string
  strong: boolean
  count: { start: number; label: string }
}) {
  return (
    <main>
      <InlineBadge native label={label} strong={strong} />
      <HookBadge native label={label} />
      <WrapCounter native c={count} />
    </main>
  )
}
