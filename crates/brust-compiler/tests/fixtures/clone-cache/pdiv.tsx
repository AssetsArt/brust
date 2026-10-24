import { Both, Prov } from './ctx'
// F372: the consumer under a plain element in Prov's content still reads Frame's K (the inner Provider).
export default function Page() {
  return (
    <main>
      <Prov>
        <div className="pad">
          <Both label="AAA" />
        </div>
      </Prov>
    </main>
  )
}
