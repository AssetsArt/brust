import Counter from '../components/Counter'
export default function TeamPage({ start, label }: { start: number; label: string }) {
  return (<><h1>Team</h1><p>Pick up to 6.</p><Counter start={start} label={label} /></>)
}
