import { label } from './label'
// A child with a job of its own (the class is computed by an imported helper), like a shadcn wrapper's `cn`.
export default function Cell({ tone = 'info', children }: any) { return <td className={label(tone)}>{children}</td> }
