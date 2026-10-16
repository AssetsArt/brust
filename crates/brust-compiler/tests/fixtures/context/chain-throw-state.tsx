import { useState } from 'react'
function Switch({ children }: { children?: React.ReactNode }) {
  const [type] = useState('single')
  if (type === 'single') {
    return <div>{children}</div>
  }
  throw new Error('bad')
}
export default function Page() {
  return (
    <main>
      <Switch>y</Switch>
    </main>
  )
}
