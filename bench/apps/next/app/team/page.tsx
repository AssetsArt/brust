import Counter from '../../components/Counter'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Team · bench' }
export default function TeamPage() {
  return (<><h1>Team</h1><p>Pick up to 6.</p><Counter start={0} label="clicks" /></>)
}
