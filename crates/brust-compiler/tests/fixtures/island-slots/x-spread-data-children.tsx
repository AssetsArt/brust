import { Tip } from './ui'

export default function Page({ data }: { data: Record<string, unknown> }) {
  return <Tip {...data}>body</Tip>
}
