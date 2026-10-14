// F153c: shadcn's Label (Radix `@radix-ui/react-label` underneath) compiled from the package's own source.
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

export default function Page() {
  return (
    <div className="grid w-full max-w-sm gap-3">
      <Label htmlFor="email" data-testid="label">Your email address</Label>
      <Input id="email" type="email" data-testid="input" />
      <Label data-testid="with-button">
        Agree <button type="button" data-testid="inner">?</button>
      </Label>
    </div>
  )
}
