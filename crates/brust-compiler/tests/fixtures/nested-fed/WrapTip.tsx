// A static wrapper mapping an island over its own rows (inlined into its callers).
import Tip from './Tip'
export default function WrapTip({ rows }: any) {
  return <div>{rows.map((r: string) => <Tip key={r} t={r} />)}</div>
}
