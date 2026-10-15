const el = <b>hi</b>

export default function Page() {
  const on = true
  return <section>{on && el}</section>
}
