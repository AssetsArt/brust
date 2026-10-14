import { Progress } from 'radix-ui'

export default function Page() {
  return (
    <Progress.Root value={50} max={200} className="bar">
      <Progress.Indicator className="fill" />
    </Progress.Root>
  )
}
