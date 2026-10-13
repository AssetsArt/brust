import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Toaster } from '../components/ui/sonner'

export default function Page() {
  return (
    <>
      <Button variant="outline" onClick={() => toast('Event has been created')}>
        Show Toast
      </Button>
      <Toaster />
    </>
  )
}
