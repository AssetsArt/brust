export interface HelloWorldProps {
  workerId: string
}

export default function HelloWorld({ workerId }: HelloWorldProps) {
  return (
    <>
      <h1>Hello from Brust</h1>
      <p>worker_id={workerId}</p>
    </>
  )
}
