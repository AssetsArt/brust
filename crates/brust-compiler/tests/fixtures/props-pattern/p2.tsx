export default function C({ icon = <b>i</b>, n = 1 }: { icon?: unknown; n?: number }) {
  return <div>{icon}{n}</div>
}
