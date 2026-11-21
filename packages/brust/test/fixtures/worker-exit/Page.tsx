// F604: a page whose loader the worker never finishes: the worker exits mid-call (the worker-exit test).
export default function Page({ v }: { v: string }) {
  return <p>{v}</p>
}
