import type { RouteContext } from '../../../runtime/routes.ts'

export interface HelloWorldProps extends RouteContext {
  workerId?: string
}

export default function HelloWorld({ workerId = '' }: HelloWorldProps) {
  return (
    <>
      <h1>Hello from Brust</h1>
      <p>{`worker_id=${workerId}`}</p>
    </>
  )
}
