function Switch({ type, msg, children }: { type?: string; msg?: string; children?: React.ReactNode }) {
  if (type === 'single') {
    return <div>{children}</div>
  }
  throw new Error(msg)
}
export default function Page() {
  return (
    <main>
      <Switch type="single" msg="x">y</Switch>
    </main>
  )
}
