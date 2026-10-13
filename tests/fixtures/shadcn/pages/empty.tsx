import { Button } from '../components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty'

export default function Page() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">∅</EmptyMedia>
        <EmptyTitle>No projects yet</EmptyTitle>
        <EmptyDescription>Get started by creating your first project.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>Create project</Button>
      </EmptyContent>
    </Empty>
  )
}
