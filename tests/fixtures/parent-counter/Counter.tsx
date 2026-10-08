export default function Counter({ n, onReset }: { n: number; onReset: () => void }) {
  return <button onClick={onReset}>{n}</button>
}
