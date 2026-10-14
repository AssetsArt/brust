// shadcn TableCell's shape: a class computed by an imported helper (a precompute job), children as markup.
import { label } from './label'
export default function Cell({ tone = 'info', children }: any) {
  return <td className={label(tone)}>{children}</td>
}
