import { Toggle } from '../components/ui/toggle'

export default function Page() {
  return (
    <div className="flex gap-2">
      <Toggle aria-label="Toggle italic">Italic</Toggle>
      <Toggle variant="outline" aria-label="Toggle bold">Bold</Toggle>
    </div>
  )
}
