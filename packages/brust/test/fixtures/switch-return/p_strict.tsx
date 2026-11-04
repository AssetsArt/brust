import { Num } from './Kit'

export default function Page() {
  return (
    <main>
      <Num n={1} />
      <Num n="1" />
      <Num n={3} />
      <Num n="3" />
      <Num n={7} />
    </main>
  )
}
