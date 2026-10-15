const xs = ['a']
class Box {
  v = 1
  static k = 2
}
export default function Page() {
  return <section>{xs.join(',')}</section>
}
