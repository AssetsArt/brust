// Review r1 (Afrojack) pin: a fed child whose job input is the parent's own `children` (markup, never a job input)
// serves React's markup. Two rules stop it: the caller of a component that reads `children` as a value falls back
// (`reads_children_value`, pre-existing), and `try_fuse` refuses a `children` root (fused_jobs.rs pins that one).
import { cn } from "cn"

function ChildrenLabelCell({ active, className }: { active?: unknown; className?: string }) {
  return <td className={cn("cell", active ? "on" : "off", className)}>cell</td>
}

function ChildrenLabelRow({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <tr className={cn("row", className)}>
      <ChildrenLabelCell active={children} />
    </tr>
  )
}

export default function ChildrenLabelPage() {
  return (
    <table>
      <tbody>
        <ChildrenLabelRow className="x">hi</ChildrenLabelRow>
      </tbody>
    </table>
  )
}
