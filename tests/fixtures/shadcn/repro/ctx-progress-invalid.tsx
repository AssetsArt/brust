import { Progress } from 'radix-ui'

// value above max: Radix logs an error and renders as indeterminate; brust leaves the log out.
export default function Page() {
  return (
    <Progress.Root value={150}>
      <Progress.Indicator />
    </Progress.Root>
  )
}
