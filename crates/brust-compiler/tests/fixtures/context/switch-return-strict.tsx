function Num({ n }: { n: number }) {
  switch (n) {
    case 1:
      return <p>one</p>
    case 2:
    case 3:
      return <p>few</p>
    default:
      return <p>other</p>
  }
}
export default function Page() {
  return (
    <main>
      <Num n={1} />
      <Num n={3} />
      <Num n={7} />
    </main>
  )
}
