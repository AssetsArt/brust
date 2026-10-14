import { Progress } from 'radix-ui'

export default function Page() {
  return (
    <Progress.Root value={66} className="w-[60%]">
      <Progress.Indicator style={{ transform: 'translateX(-34%)' }} />
    </Progress.Root>
  )
}
