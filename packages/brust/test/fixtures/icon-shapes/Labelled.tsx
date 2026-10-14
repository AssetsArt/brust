import { Ico } from '@/components/ui/ico'

// An icon that reads `aria-*`, `role`, `title` or `nonScalingStroke` itself drops its own `aria-hidden`: brust cannot
// bake that, so these call sites render with React (and equal its HTML).
export default function Page() {
  return (
    <main>
      <Ico />
      <Ico aria-label="next" />
      <Ico role="img" />
      <Ico title="t" />
      <Ico nonScalingStroke />
      <Ico data-x="1" />
    </main>
  )
}
