const NAME = 'Switch'
function Switch({ type, children }: { type?: string; children?: React.ReactNode }) {
  if (type === 'single') {
    const role = 'radiogroup'
    return <div role={role}>{children}</div>
  }
  if (type === 'multiple') {
    return <div role="toolbar">{children}</div>
  }
  throw new Error(`Missing prop \`type\` expected on \`${NAME}\``)
}
export default function SwPage({ kind }: { kind: string }) {
  return (
    <main>
      <Switch type={kind}>content</Switch>
    </main>
  )
}
