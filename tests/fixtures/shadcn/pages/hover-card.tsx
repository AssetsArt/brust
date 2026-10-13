import { Button } from '../components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../components/ui/hover-card'

export default function Page() {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link">@nextjs</Button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <p className="text-sm">The React Framework – created and maintained by @vercel.</p>
      </HoverCardContent>
    </HoverCard>
  )
}
