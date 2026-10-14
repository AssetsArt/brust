import { Card, Input, Label, Root } from './parts'

export default function Page() {
  return (
    <main>
      <Card className="p-4" id="c1">
        <Label htmlFor="name" className="font-medium">Name</Label>
        <Input id="name" placeholder="Ada" />
        <Input type="email" disabled />
      </Card>
      <Root>second</Root>
    </main>
  )
}
