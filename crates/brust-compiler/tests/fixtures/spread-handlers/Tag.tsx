// A child with a job of its own (an imported helper) and a defaulted prop.
import { label } from './label'
export default function Tag({ tone = 'info', text }: any) {
  return <b className={label(tone)}>{text}</b>
}
