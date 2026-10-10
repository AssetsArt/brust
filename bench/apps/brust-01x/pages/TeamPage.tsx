import { Island } from '../../../../runtime/index.ts'
import Counter from '../components/Counter'
export default function TeamPage({ teamProps }: { teamProps: { start: number; label: string } }) {
  return (
    <>
      <h1>Team</h1>
      <p>Pick up to 6.</p>
      <Island component={Counter} props={teamProps} ssr hydrate="load" />
    </>
  )
}
