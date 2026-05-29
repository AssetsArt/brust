import Counter from '../../../example/hello-world/components/Counter.tsx'

export default function NativeIslandPage({ greeting, count }: { greeting: string; count: { start: number } }) {
  return (
    <div>
      <h1>{greeting}</h1>
      <Island component={Counter} props={count} />
    </div>
  )
}
