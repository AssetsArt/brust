function pick(x = <b>hi</b>) {
  return x
}

export default function Page() {
  return <section>{pick()}</section>
}
