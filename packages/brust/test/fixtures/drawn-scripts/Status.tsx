import W4 from './W4'

export default function Status({ kind }: { kind: string }) {
  return <section id="status">{kind === 'w4' ? <W4 /> : <p>no widget</p>}</section>
}
