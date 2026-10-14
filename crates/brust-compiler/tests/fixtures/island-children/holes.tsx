import { Card } from './ui'

export default function Page({ title, ok, who }: { title: string; ok: boolean; who: { name: string } }) {
  return (
    <Card title="t">
      <h3 title={title}>{who.name}</h3>
      {ok && <u>on</u>}
      <input disabled={ok} />
    </Card>
  )
}
