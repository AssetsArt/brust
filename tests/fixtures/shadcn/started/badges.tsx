// F142 R34.43 started-server check: shadcn's Badge (a job of its own: cva + cn) reads each row of a module
// const, so the manifest carries the rows (`per-row-literal`) and the server feeds one instance per row.
import { Badge } from "../components/ui/badge"

const statuses = [
  { id: "paid", label: "Paid", variant: "default" },
  { id: "pending", label: "Pending", variant: "secondary" },
  { id: "failed", label: "Failed", variant: "destructive" },
] as const

export default function BadgesPage() {
  return (
    <div className="flex gap-2">
      {statuses.map((s) => (
        <Badge key={s.id} variant={s.variant} data-status={s.id}>
          {s.label}
        </Badge>
      ))}
    </div>
  )
}
