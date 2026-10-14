import { Tip } from './ui'

export default function Page() {
  return <Tip {...{ $x: ['data'] }} data="x" />
}
