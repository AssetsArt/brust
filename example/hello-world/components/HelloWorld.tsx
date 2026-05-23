import { Island } from '../../../runtime/index.ts'
import Counter from './Counter'
import type { RouteContext } from '../../../runtime/routes.ts'

export default function HelloWorld({ workerId }: RouteContext) {
  return (
    <>
      <h1>Hello from Brust</h1>
      <p>{`worker_id=${workerId ?? ''}`}</p>
      <Island
        id="Counter"
        component={Counter}
        props={{ start: 0, label: 'clicks' }}
        hydrate="load"
      />
    </>
  )
}
