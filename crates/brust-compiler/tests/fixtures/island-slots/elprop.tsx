import { Badge, Tip } from './ui'

export default function Page() {
  return <Tip content={<Badge n={1} />}>body</Tip>
}
