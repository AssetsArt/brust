import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

export default function Page() {
  return (
    <div className="grid w-full max-w-sm gap-3">
      <Label htmlFor="email">Your email address</Label>
      <Input id="email" type="email" />
    </div>
  )
}
