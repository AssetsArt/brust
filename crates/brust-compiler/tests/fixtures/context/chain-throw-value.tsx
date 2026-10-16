function Switch({ type, children }: { type?: string; children?: React.ReactNode }) {
  if (type === 'single') {
    return <div>{children}</div>
  }
  throw 'nope'
}
export default function Page() {
  return (
    <main>
      <Switch type="single">y</Switch>
    </main>
  )
}
