function View({ type, children }: { type: string; children?: React.ReactNode }) {
  switch (type) {
    case 'a':
      console.log('a')
    case 'b':
      return <p>{children}</p>
    default:
      return <div>{children}</div>
  }
}
export default function Page() {
  return (
    <main>
      <View type="a">x</View>
    </main>
  )
}
