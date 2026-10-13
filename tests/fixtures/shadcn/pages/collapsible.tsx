import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'

export default function Page() {
  return (
    <Collapsible className="w-[350px] space-y-2">
      <div className="flex items-center justify-between gap-4 px-4">
        <h4 className="text-sm font-semibold">@peduarte starred 3 repositories</h4>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">Toggle</Button>
        </CollapsibleTrigger>
      </div>
      <div className="rounded-md border px-4 py-2 font-mono text-sm">@radix-ui/primitives</div>
      <CollapsibleContent className="space-y-2">
        <div className="rounded-md border px-4 py-2 font-mono text-sm">@radix-ui/colors</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
