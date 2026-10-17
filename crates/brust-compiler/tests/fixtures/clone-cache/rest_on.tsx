import { OnlyOn, Outer } from './ctx'
// F298: content reading Prov's own context reaches Prov in the wrapper's spread: the wrapper is cloned with it.
export default function Page() {
  return (
    <main>
      <Outer>
        <OnlyOn label="ON" />
      </Outer>
    </main>
  )
}
