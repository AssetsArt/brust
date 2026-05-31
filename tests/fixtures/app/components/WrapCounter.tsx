import Counter from './Counter'
export default function WrapCounter({ c }: { c: { start: number; label: string } }) {
  return (
    <div class="wrap">
      <Island component={Counter} props={c} hydrate="load" />
    </div>
  )
}
