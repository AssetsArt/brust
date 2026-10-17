import { Both, Outer } from './ctx'
// F374 + F371: content reading Frame's context reaches Prov in the wrapper's spread.
export default function Page() {
  return (
    <main>
      <Outer>
        <Both label="AAA" />
      </Outer>
    </main>
  )
}
