// Dialog content with only Title and Description: package-source context consumers with no job, under the dist Root island.
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog'

export default function Page() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Open</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Only title</DialogTitle>
          <DialogDescription>and a description</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
