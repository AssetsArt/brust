import { useState } from 'react'
function Switch({ type, children }: { type?: string; children?: React.ReactNode }) {
  if (type === 'single') {
    return <div role="radiogroup">{children}</div>
  }
  if (type === 'multiple') {
    return <div role="toolbar">{children}</div>
  }
  throw new Error('Missing type')
}
export default function Page() {
  const [t, setT] = useState('single')
  return (
    <main>
      <button onClick={() => setT(t === 'single' ? 'multiple' : 'single')}>flip</button>
      <Switch type={t}>y</Switch>
    </main>
  )
}
