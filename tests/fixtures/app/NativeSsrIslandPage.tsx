import Counter from '../../../example/hello-world/components/Counter'

export default function NativeSsrIslandPage({ greeting, count }: { greeting: string; count: { start: number } }) {
  return (
    <div>
      <h1>{greeting}</h1>
      <Island component={Counter} props={count} ssr />
    </div>
  )
}
