import { Card } from './ui'

export default function Frame({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="frame">
      <Card title="x">
        <b>{title}</b>
        {children}
      </Card>
    </div>
  )
}
