import { ScrollArea } from '../components/ui/scroll-area'
import { Separator } from '../components/ui/separator'

const tags = Array.from({ length: 20 }).map((_, i, a) => `v1.2.0-beta.${a.length - i}`)

export default function Page() {
  return (
    <ScrollArea className="h-72 w-48 rounded-md border">
      <div className="p-4">
        <h4 className="mb-4 text-sm leading-none font-medium">Tags</h4>
        {tags.map((tag) => (
          <div key={tag}>
            <div className="text-sm">{tag}</div>
            <Separator className="my-2" />
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
