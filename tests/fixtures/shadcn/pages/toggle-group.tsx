import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'

export default function Page() {
  return (
    <ToggleGroup type="multiple" variant="outline">
      <ToggleGroupItem value="bold" aria-label="Toggle bold">B</ToggleGroupItem>
      <ToggleGroupItem value="italic" aria-label="Toggle italic">I</ToggleGroupItem>
      <ToggleGroupItem value="underline" aria-label="Toggle underline">U</ToggleGroupItem>
    </ToggleGroup>
  )
}
