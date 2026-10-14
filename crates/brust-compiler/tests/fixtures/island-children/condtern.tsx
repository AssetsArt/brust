import { Card } from './ui'

export default function Page({ ok }: { ok: boolean }) {
  return <Card title="t">{ok ? <u>on</u> : null}</Card>
}
