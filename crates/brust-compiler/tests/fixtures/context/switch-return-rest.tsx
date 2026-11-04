function View({ type, children }: { type: string; children?: React.ReactNode }) {
  switch (type) {
    case 'a':
      return <p>{children}</p>
    case 'b':
      return <section>{children}</section>
  }
  return <div>{children}</div>
}
export default function Page() {
  return (
    <main>
      <View type="a">x</View>
      <View type="b">y</View>
      <View type="c">z</View>
    </main>
  )
}
