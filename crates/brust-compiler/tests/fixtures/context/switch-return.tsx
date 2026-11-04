function View({ type, children }: { type: string; children?: React.ReactNode }) {
  switch (type) {
    case 'hero': {
      const tag = 'H:' + type
      return <h1 data-t={tag}>{children}</h1>
    }
    case 'promo':
    case 'sale':
      return <p data-t="promo">{children}</p>
    default:
      return <div>{children}</div>
  }
}
export default function Page() {
  return (
    <main>
      <View type="hero">a</View>
      <View type="sale">b</View>
      <View type="x">c</View>
    </main>
  )
}
