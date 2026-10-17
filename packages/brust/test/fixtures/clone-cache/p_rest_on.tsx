import { OnlyOn, Outer } from './ctx'
// F298: content reading Prov's own context travels in the wrapper's props spread: the wrapper is cloned with it.
export default function Page() {
  return (
    <main>
      <Outer id="1">
        <OnlyOn label="ON" />
      </Outer>
    </main>
  )
}
