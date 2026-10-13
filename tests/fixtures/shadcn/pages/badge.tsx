import { Badge } from '../components/ui/badge'

export default function Page() {
  return (
    <div className="flex gap-2">
      <Badge>Badge</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="outline">Outline</Badge>
    </div>
  )
}
