import { useState } from 'react'

function Card({ children }: { children?: React.ReactNode }) {
  return <div className="card">{children}</div>
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <Card>
      <button onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>
    </Card>
  )
}
