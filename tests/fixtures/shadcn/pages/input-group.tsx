import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group'

export default function Page() {
  return (
    <InputGroup className="max-w-sm">
      <InputGroupInput placeholder="Search..." />
      <InputGroupAddon>
        <span>🔍</span>
      </InputGroupAddon>
    </InputGroup>
  )
}
