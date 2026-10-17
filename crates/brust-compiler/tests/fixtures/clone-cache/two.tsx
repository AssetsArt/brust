import { Both, Prov } from './ctx'
// F238: two clones of Prov with different content; inside each, Frame is specialised with that clone's content.
export default function Page() {
  return (
    <main>
      <Prov>
        <Both label="AAA" />
      </Prov>
      <Prov>
        <Both label="BBB" />
      </Prov>
    </main>
  )
}
