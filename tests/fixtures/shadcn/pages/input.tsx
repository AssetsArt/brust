import { Input } from '../components/ui/input'

export default function Page() {
  return (
    <div className="grid w-full max-w-sm gap-2">
      <Input type="email" placeholder="Email" />
      <Input type="file" />
      <Input disabled placeholder="Disabled" />
    </div>
  )
}
