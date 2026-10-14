export default function Page({ n }: { n?: number }) {
  let x = 1
  if (n) {
    x = 2
  }
  return <p>{x}</p>
}
