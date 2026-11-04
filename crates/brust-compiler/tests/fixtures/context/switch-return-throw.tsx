function View({ type, children }: { type: string; children?: React.ReactNode }) {
  switch (type) {
    case 'a':
      return <p>{children}</p>
    default:
      throw new Error('unknown type')
  }
}
export default function Page() {
  return (
    <main>
      <View type="a">x</View>
    </main>
  )
}
