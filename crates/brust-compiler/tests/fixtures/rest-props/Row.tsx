// A child with a precompute job of its own (a module helper call): the server feeds it per instance.
import { label } from './label'
export default function Row({ name }: any) {
  return <li>{label(name)}</li>
}
