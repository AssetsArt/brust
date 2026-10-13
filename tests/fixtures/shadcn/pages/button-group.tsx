import { Button } from '../components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '../components/ui/button-group'

export default function Page() {
  return (
    <ButtonGroup>
      <Button variant="outline">Archive</Button>
      <ButtonGroupSeparator />
      <Button variant="outline">Report</Button>
    </ButtonGroup>
  )
}
