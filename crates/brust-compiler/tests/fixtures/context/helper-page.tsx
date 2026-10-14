import { Fill, Meter } from './helper/provider'

export default function Page({ v }: { v: number }) {
  return (
    <Meter value={v}>
      <Fill />
    </Meter>
  )
}
