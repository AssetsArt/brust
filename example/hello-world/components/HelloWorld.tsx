import type { RouteContext } from '../../../runtime/routes.ts'

export default function HelloWorld({ workerId }: RouteContext) {
  return (
    <>
      <h1>Hello from Brust</h1>
      <p>{`worker_id=${workerId ?? ''}`}</p>
    </>
  )
}
