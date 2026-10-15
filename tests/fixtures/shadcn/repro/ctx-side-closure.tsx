const B = (() => {
  let v = 'x'
  return {
    put(n: string) {
      v = n
    },
    get() {
      return v
    },
  }
})()
B.put('y')

export default function Page() {
  return <section>{B.get()}</section>
}
